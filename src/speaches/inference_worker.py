from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import os
import sys
import threading
from typing import TYPE_CHECKING, Any, BinaryIO

if TYPE_CHECKING:
    from collections.abc import Callable


PROTOCOL_VERSION = 1
type RequestId = int | str
type JsonObject = dict[str, Any]


class RpcMethodError(Exception):
    def __init__(self, code: str, message: str, data: JsonObject | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


@dataclass(frozen=True)
class RequestContext:
    cancelled: threading.Event
    emit: Callable[[Any], None]

    def raise_if_cancelled(self) -> None:
        if self.cancelled.is_set():
            raise RpcMethodError("request_cancelled", "Request cancelled by caller")


def _create_registry() -> Any:
    # Keep imports lazy so `ping` proves the transport without paying the model
    # runtime import cost. The first model load or inference call owns that cost.
    from speaches.config import Config
    from speaches.executors.shared.registry import ExecutorRegistry as SpeachesExecutorRegistry

    return SpeachesExecutorRegistry(Config())


class InferenceWorkerService:
    def __init__(self, registry_factory: Callable[[], Any] = _create_registry) -> None:
        self._registry_factory = registry_factory
        self._registry: Any | None = None
        self._registry_lock = threading.Lock()

    @property
    def registry(self) -> Any:
        with self._registry_lock:
            if self._registry is None:
                self._registry = self._registry_factory()
            return self._registry

    def call(self, method: str, params: JsonObject, context: RequestContext) -> Any:
        methods: dict[str, Callable[[JsonObject, RequestContext], Any]] = {
            "ping": self._ping,
            "list_loaded": self._list_loaded,
            "load_model": self._load_model,
            "unload_model": self._unload_model,
        }
        handler = methods.get(method)
        if handler is None:
            raise RpcMethodError("method_not_found", f"Unknown method: {method}")
        context.raise_if_cancelled()
        return handler(params, context)

    def _ping(self, _params: JsonObject, _context: RequestContext) -> JsonObject:
        return {"protocol_version": PROTOCOL_VERSION, "pid": os.getpid()}

    def _list_loaded(self, _params: JsonObject, context: RequestContext) -> JsonObject:
        # If no method has constructed the executor registry, no model can have
        # been loaded. Keep this diagnostic fast so the control plane can probe
        # a fresh worker without importing every inference backend.
        with self._registry_lock:
            registry = self._registry
        if registry is None:
            return {"models": []}

        models: list[str] = []
        for executor in registry.all_executors():
            context.raise_if_cancelled()
            models.extend(executor.model_manager.loaded_models.keys())
        return {"models": list(dict.fromkeys(models))}

    def _load_model(self, params: JsonObject, context: RequestContext) -> JsonObject:
        model_id = _required_string(params, "model_id")
        executors = tuple(self.registry.all_executors())
        for executor in executors:
            if model_id in executor.model_manager.loaded_models:
                raise RpcMethodError("model_already_loaded", f"Model '{model_id}' is already loaded")

        executor = self._find_local_executor(model_id, executors, context)
        context.raise_if_cancelled()
        with executor.model_manager.load_model(model_id):
            context.raise_if_cancelled()
        return {"model_id": model_id, "executor": executor.name, "task": executor.task}

    def _unload_model(self, params: JsonObject, context: RequestContext) -> JsonObject:
        model_id = _required_string(params, "model_id")
        with self._registry_lock:
            registry = self._registry
        if registry is None:
            raise RpcMethodError("model_not_loaded", f"Model '{model_id}' is not loaded")

        for executor in registry.all_executors():
            context.raise_if_cancelled()
            if model_id not in executor.model_manager.loaded_models:
                continue
            try:
                executor.model_manager.unload_model(model_id)
            except ValueError as error:
                raise RpcMethodError("model_in_use", str(error)) from error
            return {"model_id": model_id, "executor": executor.name, "task": executor.task}
        raise RpcMethodError("model_not_loaded", f"Model '{model_id}' is not loaded")

    @staticmethod
    def _find_local_executor(model_id: str, executors: tuple[Any, ...], context: RequestContext) -> Any:
        for executor in executors:
            context.raise_if_cancelled()
            if any(model.id == model_id for model in executor.model_registry.list_local_models()):
                return executor
        raise RpcMethodError(
            "model_not_available",
            f"Model '{model_id}' is not installed locally or is not supported",
        )


def _required_string(params: JsonObject, key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise RpcMethodError("invalid_params", f"'{key}' must be a non-empty string")
    return value


class InferenceRpcServer:
    def __init__(self, service: InferenceWorkerService, *, max_workers: int = 1) -> None:
        self._service = service
        self._executor = ThreadPoolExecutor(max_workers=max(1, max_workers), thread_name_prefix="speachy-rpc")
        self._active: dict[RequestId, threading.Event] = {}
        self._active_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._output: BinaryIO | None = None

    def run(self, input_stream: BinaryIO, output_stream: BinaryIO) -> None:
        self._output = output_stream
        try:
            for raw_line in input_stream:
                if not raw_line.strip():
                    continue
                self._accept_line(raw_line)
        finally:
            self._executor.shutdown(wait=True, cancel_futures=False)

    def _accept_line(self, raw_line: bytes) -> None:
        try:
            message = json.loads(raw_line)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            self._send_error(None, "parse_error", f"Invalid JSON: {error}")
            return

        if not isinstance(message, dict):
            self._send_error(None, "invalid_request", "Request must be a JSON object")
            return

        request_id = message.get("id")
        if not isinstance(request_id, int | str) or isinstance(request_id, bool):
            self._send_error(None, "invalid_request", "Request 'id' must be a string or integer")
            return

        if message.get("type") == "cancel":
            with self._active_lock:
                cancelled = self._active.get(request_id)
            if cancelled is not None:
                cancelled.set()
            return

        method = message.get("method")
        params = message.get("params", {})
        if not isinstance(method, str) or not method:
            self._send_error(request_id, "invalid_request", "Request 'method' must be a non-empty string")
            return
        if not isinstance(params, dict):
            self._send_error(request_id, "invalid_request", "Request 'params' must be an object")
            return

        cancelled = threading.Event()
        with self._active_lock:
            if request_id in self._active:
                self._send_error(request_id, "duplicate_request", f"Request '{request_id}' is already active")
                return
            self._active[request_id] = cancelled
        self._executor.submit(self._execute, request_id, method, params, cancelled)

    def _execute(self, request_id: RequestId, method: str, params: JsonObject, cancelled: threading.Event) -> None:
        context = RequestContext(
            cancelled=cancelled,
            emit=lambda event: self._send({"id": request_id, "type": "event", "event": event}),
        )
        try:
            result = self._service.call(method, params, context)
            context.raise_if_cancelled()
            self._send({"id": request_id, "type": "result", "result": result})
        except RpcMethodError as error:
            self._send_error(request_id, error.code, str(error), error.data)
        except Exception as error:  # noqa: BLE001
            print(f"Inference worker method '{method}' failed: {error!r}", file=sys.stderr, flush=True)
            self._send_error(request_id, "internal_error", "Inference worker method failed")
        finally:
            with self._active_lock:
                self._active.pop(request_id, None)

    def _send_error(
        self, request_id: RequestId | None, code: str, message: str, data: JsonObject | None = None
    ) -> None:
        error: JsonObject = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._send({"id": request_id, "type": "error", "error": error})

    def _send(self, message: JsonObject) -> None:
        assert self._output is not None
        encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"
        with self._write_lock:
            self._output.write(encoded)
            self._output.flush()


def main() -> None:
    max_workers_raw = os.getenv("SPEACHY_INFERENCE_WORKERS", "1")
    try:
        max_workers = max(1, int(max_workers_raw))
    except ValueError:
        print("SPEACHY_INFERENCE_WORKERS must be an integer", file=sys.stderr, flush=True)
        raise SystemExit(2) from None

    server = InferenceRpcServer(InferenceWorkerService(), max_workers=max_workers)
    server.run(sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    main()
