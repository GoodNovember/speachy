from __future__ import annotations

import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import math
import os
import sys
import threading
from typing import TYPE_CHECKING, Any, BinaryIO, Literal, cast

if TYPE_CHECKING:
    from collections.abc import Callable


PROTOCOL_VERSION = 1
type RequestId = int | str
type JsonObject = dict[str, Any]
type ResponseFormat = Literal["json", "srt", "text", "verbose_json", "vtt"]
type TimestampGranularity = Literal["segment", "word"]


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

    def prepare(self, method: str) -> None:
        # Some native runtime modules must be initialized on Python's main
        # thread. Preserve a fast ping/list-loaded path, but initialize the
        # shared registry before dispatching the first model operation to the
        # executor thread.
        if method in {"load_model", "transcribe", "translate"}:
            _ = self.registry

    def call(self, method: str, params: JsonObject, context: RequestContext) -> Any:
        methods: dict[str, Callable[[JsonObject, RequestContext], Any]] = {
            "ping": self._ping,
            "list_loaded": self._list_loaded,
            "load_model": self._load_model,
            "unload_model": self._unload_model,
            "transcribe": self._transcribe,
            "translate": self._translate,
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

    def _transcribe(self, params: JsonObject, context: RequestContext) -> JsonObject:
        from pydantic import ValidationError

        from speaches.executors.shared.handler_protocol import TranscriptionRequest
        from speaches.executors.silero_vad_v5 import SpeechTimestamp, VadOptions

        model_id = _required_string(params, "model")
        audio = _decode_audio(_required_object(params, "audio"))
        vad_params = dict(_required_object(params, "vad_options"))
        if vad_params.get("max_speech_duration_s") is None:
            vad_params["max_speech_duration_s"] = float("inf")

        try:
            request = TranscriptionRequest(
                audio=audio,
                model=model_id,
                stream=False,
                language=_optional_string(params, "language"),
                prompt=_optional_string(params, "prompt"),
                response_format=_required_response_format(params),
                temperature=_required_number(params, "temperature"),
                hotwords=_optional_string(params, "hotwords"),
                timestamp_granularities=_required_timestamp_granularities(params),
                speech_segments=[
                    SpeechTimestamp.model_validate(segment)
                    for segment in _required_object_list(params, "speech_segments")
                ],
                vad_options=VadOptions.model_validate(vad_params),
                without_timestamps=_required_bool(params, "without_timestamps"),
            )
        except (ValidationError, ValueError, TypeError) as error:
            raise RpcMethodError("invalid_params", f"Invalid transcription request: {error}") from error

        executor = self._find_local_executor(model_id, tuple(self.registry.transcription), context)
        context.raise_if_cancelled()
        response = executor.model_manager.handle_non_streaming_transcription_request(request)
        context.raise_if_cancelled()
        return _serialize_transcription(response)

    def _translate(self, params: JsonObject, context: RequestContext) -> JsonObject:
        from pydantic import ValidationError

        from speaches.executors.shared.handler_protocol import TranslationRequest
        from speaches.executors.silero_vad_v5 import SpeechTimestamp, VadOptions

        model_id = _required_string(params, "model")
        audio = _decode_audio(_required_object(params, "audio"))
        vad_params = dict(_required_object(params, "vad_options"))
        if vad_params.get("max_speech_duration_s") is None:
            vad_params["max_speech_duration_s"] = float("inf")

        try:
            request = TranslationRequest(
                audio=audio,
                model=model_id,
                prompt=_optional_string(params, "prompt"),
                response_format=_required_response_format(params),
                temperature=_required_number(params, "temperature"),
                speech_segments=[
                    SpeechTimestamp.model_validate(segment)
                    for segment in _required_object_list(params, "speech_segments")
                ],
                vad_options=VadOptions.model_validate(vad_params),
            )
        except (ValidationError, ValueError, TypeError) as error:
            raise RpcMethodError("invalid_params", f"Invalid translation request: {error}") from error

        executor = self._find_local_executor(model_id, tuple(self.registry.translation), context)
        context.raise_if_cancelled()
        response = executor.model_manager.handle_translation_request(request)
        context.raise_if_cancelled()
        return _serialize_transcription(response)

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


def _optional_string(params: JsonObject, key: str) -> str | None:
    value = params.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise RpcMethodError("invalid_params", f"'{key}' must be a string or null")
    return value


def _required_number(params: JsonObject, key: str) -> float:
    value = params.get(key)
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise RpcMethodError("invalid_params", f"'{key}' must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise RpcMethodError("invalid_params", f"'{key}' must be finite")
    return number


def _required_bool(params: JsonObject, key: str) -> bool:
    value = params.get(key)
    if not isinstance(value, bool):
        raise RpcMethodError("invalid_params", f"'{key}' must be a boolean")
    return value


def _required_object(params: JsonObject, key: str) -> JsonObject:
    value = params.get(key)
    if not isinstance(value, dict):
        raise RpcMethodError("invalid_params", f"'{key}' must be an object")
    return value


def _required_object_list(params: JsonObject, key: str) -> list[JsonObject]:
    value = params.get(key)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise RpcMethodError("invalid_params", f"'{key}' must be an array of objects")
    return value


def _required_response_format(params: JsonObject) -> ResponseFormat:
    value = _required_string(params, "response_format")
    if value not in ("json", "srt", "text", "verbose_json", "vtt"):
        raise RpcMethodError("invalid_params", f"Unsupported transcription response format: {value}")
    return cast("ResponseFormat", value)


def _required_timestamp_granularities(params: JsonObject) -> list[TimestampGranularity]:
    value = params.get("timestamp_granularities")
    if not isinstance(value, list) or not all(item in ("segment", "word") for item in value):
        raise RpcMethodError("invalid_params", "'timestamp_granularities' must contain only segment or word")
    return cast("list[TimestampGranularity]", value)


def _decode_audio(value: JsonObject) -> Any:
    import numpy as np

    from speaches.audio import Audio

    if value.get("encoding") != "f32le-base64":
        raise RpcMethodError("invalid_params", "'audio.encoding' must be 'f32le-base64'")
    encoded = value.get("data")
    if not isinstance(encoded, str):
        raise RpcMethodError("invalid_params", "'audio.data' must be a base64 string")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RpcMethodError("invalid_params", "'audio.data' is not valid base64") from error
    if len(raw) % 4 != 0:
        raise RpcMethodError("invalid_params", "Decoded f32le audio length must be divisible by four")

    sample_rate = value.get("sample_rate")
    if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
        raise RpcMethodError("invalid_params", "'audio.sample_rate' must be a positive integer")
    name = value.get("name")
    if name is not None and not isinstance(name, str):
        raise RpcMethodError("invalid_params", "'audio.name' must be a string or null")

    samples = np.frombuffer(raw, dtype="<f4").astype(np.float32, copy=False)
    if not np.isfinite(samples).all():
        raise RpcMethodError("invalid_params", "Decoded audio samples must all be finite")
    return Audio(samples, sample_rate=sample_rate, name=name)


def _serialize_transcription(response: Any) -> JsonObject:
    if isinstance(response, tuple):
        text, _media_type = response
        if not isinstance(text, str):
            raise RpcMethodError("invalid_worker_response", "Transcription text must be a string")
        return {"text": text}
    model_dump = getattr(response, "model_dump", None)
    if callable(model_dump):
        value = model_dump(mode="json", exclude_none=True)
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            return value
    raise RpcMethodError("invalid_worker_response", "Unsupported transcription response from executor")


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

        try:
            self._service.prepare(method)
        except Exception as error:  # noqa: BLE001
            print(f"Inference worker preparation for '{method}' failed: {error!r}", file=sys.stderr, flush=True)
            self._send_error(request_id, "internal_error", "Inference worker preparation failed")
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
