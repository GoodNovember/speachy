from __future__ import annotations

from io import BytesIO
import json
import threading
from types import SimpleNamespace
from typing import Any

import pytest

from speaches.inference_worker import (
    InferenceRpcServer,
    InferenceWorkerService,
    RequestContext,
    RpcMethodError,
)


class FakeLease:
    def __init__(self, manager: FakeModelManager, model_id: str) -> None:
        self.manager = manager
        self.model_id = model_id

    def __enter__(self) -> object:
        self.manager.loaded_models[self.model_id] = SimpleNamespace(ref_count=1)
        return object()

    def __exit__(self, *_args: object) -> None:
        self.manager.loaded_models[self.model_id].ref_count = 0


class FakeModelManager:
    def __init__(self) -> None:
        self.loaded_models: dict[str, Any] = {}

    def load_model(self, model_id: str) -> FakeLease:
        return FakeLease(self, model_id)

    def unload_model(self, model_id: str) -> None:
        model = self.loaded_models[model_id]
        if model.ref_count > 0:
            raise ValueError(f"Model {model_id} is still in use")
        del self.loaded_models[model_id]


class FakeModelRegistry:
    def __init__(self, model_ids: list[str]) -> None:
        self.model_ids = model_ids

    def list_local_models(self):  # noqa: ANN201
        return (SimpleNamespace(id=model_id) for model_id in self.model_ids)


class FakeExecutor:
    def __init__(self, name: str, task: str, model_ids: list[str]) -> None:
        self.name = name
        self.task = task
        self.model_manager = FakeModelManager()
        self.model_registry = FakeModelRegistry(model_ids)


class FakeExecutorRegistry:
    def __init__(self) -> None:
        self.whisper = FakeExecutor("whisper", "automatic-speech-recognition", ["org/whisper-tiny"])
        self.kokoro = FakeExecutor("kokoro", "text-to-speech", ["org/kokoro"])

    def all_executors(self):  # noqa: ANN201
        return (self.whisper, self.kokoro)


def context() -> RequestContext:
    return RequestContext(cancelled=threading.Event(), emit=lambda _event: None)


def test_lifecycle_methods_share_one_lazy_registry() -> None:
    created = 0
    registry = FakeExecutorRegistry()

    def create_registry() -> FakeExecutorRegistry:
        nonlocal created
        created += 1
        return registry

    service = InferenceWorkerService(create_registry)
    assert service.call("ping", {}, context())["protocol_version"] == 1
    assert created == 0

    assert service.call("list_loaded", {}, context()) == {"models": []}
    assert created == 0
    assert service.call("load_model", {"model_id": "org/whisper-tiny"}, context()) == {
        "model_id": "org/whisper-tiny",
        "executor": "whisper",
        "task": "automatic-speech-recognition",
    }
    assert created == 1
    assert service.call("list_loaded", {}, context()) == {"models": ["org/whisper-tiny"]}
    assert service.call("unload_model", {"model_id": "org/whisper-tiny"}, context()) == {
        "model_id": "org/whisper-tiny",
        "executor": "whisper",
        "task": "automatic-speech-recognition",
    }
    assert service.call("list_loaded", {}, context()) == {"models": []}
    assert created == 1


@pytest.mark.parametrize(
    ("method", "params", "code"),
    [
        ("missing", {}, "method_not_found"),
        ("load_model", {}, "invalid_params"),
        ("load_model", {"model_id": "org/missing"}, "model_not_available"),
        ("unload_model", {"model_id": "org/missing"}, "model_not_loaded"),
    ],
)
def test_lifecycle_methods_return_stable_error_codes(method: str, params: dict[str, Any], code: str) -> None:
    service = InferenceWorkerService(FakeExecutorRegistry)
    with pytest.raises(RpcMethodError) as caught:
        service.call(method, params, context())
    assert caught.value.code == code


def test_server_frames_results_and_structured_errors_as_ndjson() -> None:
    requests = BytesIO(
        b'{"id":1,"method":"ping","params":{}}\n{"id":2,"method":"missing","params":{}}\n{broken json}\n'
    )
    responses = BytesIO()
    server = InferenceRpcServer(InferenceWorkerService(FakeExecutorRegistry))
    server.run(requests, responses)

    messages = [json.loads(line) for line in responses.getvalue().splitlines()]
    by_id = {message["id"]: message for message in messages}
    assert by_id[1]["type"] == "result"
    assert by_id[1]["result"]["protocol_version"] == 1
    assert by_id[2] == {
        "id": 2,
        "type": "error",
        "error": {"code": "method_not_found", "message": "Unknown method: missing"},
    }
    assert by_id[None]["type"] == "error"
    assert by_id[None]["error"]["code"] == "parse_error"


def test_cancelled_context_stops_before_dispatch() -> None:
    cancelled = threading.Event()
    cancelled.set()
    service = InferenceWorkerService(FakeExecutorRegistry)
    with pytest.raises(RpcMethodError) as caught:
        service.call("list_loaded", {}, RequestContext(cancelled=cancelled, emit=lambda _event: None))
    assert caught.value.code == "request_cancelled"
