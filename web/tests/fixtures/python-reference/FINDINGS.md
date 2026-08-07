# Observed behaviour of the Python reference server

Captured with `node scripts/capture-reference.mjs`, against `speaches` at commit `993994f`, running on CPU with `Systran/faster-whisper-tiny` and `speaches-ai/Kokoro-82M-v1.0-ONNX`. Raw captures are in `endpoints.json`.

Everything below is observed, not inferred from the source. These are the details the port has to match, and several of them contradict what the code reads like.

## Deviations from the OpenAI API

**SSE streams carry no `[DONE]` sentinel.** Neither `/v1/audio/transcriptions?stream=true` nor `/v1/audio/speech` with `stream_format=sse` emits the terminating `data: [DONE]` that OpenAI sends. A client written against the OpenAI SDK that waits for it will hang until the socket closes. Framing is otherwise standard: `data: {json}\n\n`.

**Errors use FastAPI's shapes, not OpenAI's error envelope.** A 404 returns `{"detail": "Model 'x' not found"}` and a validation failure returns FastAPI's array form, `{"detail": [{"type": "missing", "loc": ["body", "model"], ...}]}`. OpenAI would return `{"error": {"message": ..., "type": ..., "code": ...}}` in both cases. Anything that parses errors through the OpenAI SDK will not recognise these.

**Model objects carry extra fields.** Alongside the standard `id`, `created`, `object`, `owned_by`, each model includes non-standard `task` and `language` (the latter is a 99-entry array for multilingual Whisper).

## Bugs in the reference

**`transcript.text.done` reports an empty transcript.** The final streaming event is `{"text": "", "type": "transcript.text.done", ...}` — the accumulated text is never populated. A client that relies on the done event rather than concatenating deltas gets nothing. The port should send the full text here; this is worth an upstream issue.

**Invalid TTS parameters kill the connection instead of returning 4xx.** `speech.py` wraps the call in `except ValueError` to convert it into a clean 422, but `handle_speech_request` is a generator, so the `ValueError` is not raised until `StreamingResponse` starts consuming it — after the 200 and its headers have gone out. The client sees a severed connection: HTTP 200, zero-byte body, `curl` exit 18.

This affects **everything** validated inside that generator, not just speed. Both an out-of-range `speed` and an unsupported `voice` behave identically. Any port that validates eagerly, before returning the stream, behaves better than the original — and should, since a 200 followed by silence is the worst possible way to report a bad request.

## Details worth matching

**Streaming WAV has a placeholder RIFF size.** The header begins `52 49 46 46 ff ff ff ff 57 41 56 45` — the chunk-size field is `0xFFFFFFFF` because the length is unknown when streaming starts. Strict WAV parsers may reject it. `pcm` is the only response format that involves no container at all.

**Word timestamps work, and land at the top level.** Despite the comment in `stt.py` that the `alias` does not work, sending repeated `timestamp_granularities[]` form fields does produce word timings, as a top-level `words` array (not nested inside segments). This matches OpenAI's placement.

**VAD returns integer milliseconds.** `/v1/audio/speech/timestamps` gives `[{"start": 64, "end": 1323}]`, not seconds and not floats.

**Transcribed text keeps Whisper's leading space.** `json` returns `"Hello, world."` (stripped) but `srt`, `vtt`, and the streaming delta all carry the leading space, e.g. `" Hello, world."`.

## Environment requirements

**ffmpeg is required for every audio format except `pcm`.** `audio.py` shells out to `ffmpeg` with `-hide_banner` to encode `wav`, `mp3`, `opus`, `flac`, and `aac`. Without a modern ffmpeg on PATH those endpoints fail with a terminated connection and a `RuntimeError` in the log rather than a clean error response. This is the dependency the Node port inherits.

**The whole stack runs CPU-only without special handling.** `uv sync` installs the CPU builds of both torch and onnxruntime on this machine, so `WHISPER__INFERENCE_DEVICE=cpu` and `WHISPER__COMPUTE_TYPE=int8` are the only settings needed.
