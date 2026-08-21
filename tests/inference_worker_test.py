from __future__ import annotations

import base64
from io import BytesIO
import json
import math
import threading
from types import SimpleNamespace
from typing import Any

import numpy as np
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
        self.last_transcription_request: Any | None = None
        self.last_translation_request: Any | None = None
        self.last_streaming_transcription_request: Any | None = None

    def load_model(self, model_id: str) -> FakeLease:
        return FakeLease(self, model_id)

    def unload_model(self, model_id: str) -> None:
        model = self.loaded_models[model_id]
        if model.ref_count > 0:
            raise ValueError(f"Model {model_id} is still in use")
        del self.loaded_models[model_id]

    def handle_non_streaming_transcription_request(self, request: Any) -> tuple[str, str]:
        self.last_transcription_request = request
        return "fixture transcript", "text/plain"

    def handle_translation_request(self, request: Any) -> tuple[str, str]:
        self.last_translation_request = request
        return "fixture translation", "text/plain"

    def handle_streaming_transcription_request(self, request: Any):  # noqa: ANN201
        self.last_streaming_transcription_request = request
        yield FakeEvent({"type": "transcript.text.delta", "delta": "fixture transcript"})
        yield FakeEvent({"type": "transcript.text.done", "text": ""})


class FakeEvent:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, **_kwargs: Any) -> dict[str, Any]:
        return self.value


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
        self.parakeet = FakeExecutor("parakeet", "automatic-speech-recognition", ["org/parakeet-tiny"])
        self.kokoro = FakeExecutor("kokoro", "text-to-speech", ["org/kokoro"])

    def all_executors(self):  # noqa: ANN201
        return (self.whisper, self.parakeet, self.kokoro)

    @property
    def transcription(self):  # noqa: ANN201
        return (self.whisper, self.parakeet)

    @property
    def translation(self):  # noqa: ANN201
        return (self.whisper,)


def context() -> RequestContext:
    return RequestContext(cancelled=threading.Event(), emit=lambda _event: None)


def transcription_params() -> dict[str, Any]:
    samples = np.array([-1.0, -0.25, 0.25, 1.0], dtype="<f4")
    return {
        "audio": {
            "encoding": "f32le-base64",
            "data": base64.b64encode(samples.tobytes()).decode(),
            "sample_rate": 16000,
            "name": "fixture",
        },
        "model": "org/whisper-tiny",
        "language": "en",
        "prompt": None,
        "response_format": "json",
        "temperature": 0,
        "hotwords": "speachy",
        "timestamp_granularities": ["segment", "word"],
        "speech_segments": [{"start": 0, "end": 4}],
        "vad_options": {
            "threshold": 0.5,
            "neg_threshold": None,
            "min_speech_duration_ms": 0,
            "max_speech_duration_s": None,
            "min_silence_duration_ms": 160,
            "speech_pad_ms": 400,
        },
        "without_timestamps": False,
    }


def translation_params() -> dict[str, Any]:
    params = transcription_params()
    for key in ("language", "hotwords", "timestamp_granularities", "without_timestamps"):
        params.pop(key)
    return params


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


def test_non_streaming_transcription_decodes_audio_and_maps_the_request() -> None:
    registry = FakeExecutorRegistry()
    service = InferenceWorkerService(lambda: registry)

    assert service.call("transcribe", transcription_params(), context()) == {"text": "fixture transcript"}
    request = registry.whisper.model_manager.last_transcription_request
    assert request is not None
    assert request.model == "org/whisper-tiny"
    assert request.stream is False
    assert request.audio.sample_rate == 16000
    assert request.audio.name == "fixture"
    np.testing.assert_array_equal(request.audio.data, np.array([-1.0, -0.25, 0.25, 1.0], dtype=np.float32))
    assert request.timestamp_granularities == ["segment", "word"]
    assert request.speech_segments[0].model_dump() == {"start": 0, "end": 4}
    assert math.isinf(request.vad_options.max_speech_duration_s)
    assert request.hotwords == "speachy"
    assert request.without_timestamps is False


def test_transcription_rejects_invalid_audio_before_loading_the_registry() -> None:
    created = 0

    def create_registry() -> FakeExecutorRegistry:
        nonlocal created
        created += 1
        return FakeExecutorRegistry()

    params = transcription_params()
    params["audio"]["data"] = "not base64"
    service = InferenceWorkerService(create_registry)
    with pytest.raises(RpcMethodError) as caught:
        service.call("transcribe", params, context())
    assert caught.value.code == "invalid_params"
    assert created == 0


def test_non_streaming_translation_maps_the_request_and_uses_translation_executors_only() -> None:
    registry = FakeExecutorRegistry()
    service = InferenceWorkerService(lambda: registry)

    assert service.call("translate", translation_params(), context()) == {"text": "fixture translation"}
    request = registry.whisper.model_manager.last_translation_request
    assert request is not None
    assert request.model == "org/whisper-tiny"
    assert request.audio.sample_rate == 16000
    assert request.prompt is None
    assert request.response_format == "json"
    assert request.speech_segments[0].model_dump() == {"start": 0, "end": 4}
    assert math.isinf(request.vad_options.max_speech_duration_s)

    unsupported = translation_params()
    unsupported["model"] = "org/parakeet-tiny"
    with pytest.raises(RpcMethodError) as caught:
        service.call("translate", unsupported, context())
    assert caught.value.code == "model_not_available"
    assert registry.parakeet.model_manager.last_translation_request is None


def test_streaming_transcription_emits_ordered_events_before_the_terminal_result() -> None:
    registry = FakeExecutorRegistry()
    service = InferenceWorkerService(lambda: registry)
    events: list[dict[str, Any]] = []
    stream_context = RequestContext(cancelled=threading.Event(), emit=events.append)

    assert service.call("transcribe_stream", transcription_params(), stream_context) == {"event_count": 2}
    assert events == [
        {"type": "transcript.text.delta", "delta": "fixture transcript"},
        {"type": "transcript.text.done", "text": ""},
    ]
    request = registry.whisper.model_manager.last_streaming_transcription_request
    assert request is not None
    assert request.stream is True


def test_streaming_transcription_checks_cancellation_between_events() -> None:
    registry = FakeExecutorRegistry()
    service = InferenceWorkerService(lambda: registry)
    cancelled = threading.Event()
    events: list[dict[str, Any]] = []

    def emit(event: dict[str, Any]) -> None:
        events.append(event)
        cancelled.set()

    with pytest.raises(RpcMethodError) as caught:
        service.call("transcribe_stream", transcription_params(), RequestContext(cancelled, emit))
    assert caught.value.code == "request_cancelled"
    assert events == [{"type": "transcript.text.delta", "delta": "fixture transcript"}]


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


def test_server_prepares_model_runtime_on_the_main_thread() -> None:
    factory_thread: threading.Thread | None = None

    def create_registry() -> FakeExecutorRegistry:
        nonlocal factory_thread
        factory_thread = threading.current_thread()
        return FakeExecutorRegistry()

    requests = BytesIO(b'{"id":1,"method":"load_model","params":{"model_id":"org/whisper-tiny"}}\n')
    responses = BytesIO()
    server = InferenceRpcServer(InferenceWorkerService(create_registry))
    server.run(requests, responses)

    messages = [json.loads(line) for line in responses.getvalue().splitlines()]
    assert factory_thread is threading.main_thread()
    assert messages[-1]["type"] == "result"
    assert messages[-1]["result"]["model_id"] == "org/whisper-tiny"


def test_cancelled_context_stops_before_dispatch() -> None:
    cancelled = threading.Event()
    cancelled.set()
    service = InferenceWorkerService(FakeExecutorRegistry)
    with pytest.raises(RpcMethodError) as caught:
        service.call("list_loaded", {}, RequestContext(cancelled=cancelled, emit=lambda _event: None))
    assert caught.value.code == "request_cancelled"
