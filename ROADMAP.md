# Roadmap: Speachy on Svelte / SvelteKit

Porting this fork from Python + FastAPI to TypeScript + SvelteKit.

**How to use this document.** Phases are ordered by dependency, not by preference — each one leaves the project in a runnable state. Tick items as they land. When an open question below gets answered, move it to the decision log with a one-line rationale so the reasoning survives.

Companion design doc (rationale, architecture, transposition detail): https://claude.ai/code/artifact/a8eeab18-05e5-4227-8cee-54bc07a47eb1

---

## Target architecture

Three shapes, same destination at three distances. We build toward **Shape B** and design so that **Shape C** is cheap.

| Shape | Control plane | Inference | Status |
| --- | --- | --- | --- |
| A | SvelteKit UI only | Python (unchanged) | Phase 1 |
| B | SvelteKit (API, realtime, registry, UI) | Python worker behind RPC | Phase 2-3 |
| C | SvelteKit | `sherpa-onnx` in worker threads | Phase 4 |

The seam that makes B to C cheap is a single executor interface. Fix it in Phase 0 and never let a route file import an executor implementation directly.

---

## Decision log

Locked decisions. Add to this as open questions resolve.

- **Adapter: community WebSocket adapter over custom server, initially.** SvelteKit has no first-class WebSocket support. Start with `@mdd95/sveltekit-adapter-node` or `adapter-node-ws` so session code stays inside SvelteKit's module graph. Keep all session logic in `src/lib/server/` so that inverting to a Hono/Polka listener later is a change to one entrypoint.
- **Inference runs in `worker_threads`, always.** `sherpa-onnx` calls are synchronous native calls that block the event loop. Python gets away with threads because native code releases the GIL; Node has no equivalent escape. This is architectural, not an optimisation — retrofitting it means rewriting every executor signature.
- **Silero VAD stays in-process.** Turn detection sits in the latency path of every realtime turn and cannot afford an RPC round trip. It runs on `onnxruntime-node` in the main process even during Shape B.
- **Port the test suite before the implementation.** The 16 pytest files are an executable specification of the API contract, written against the OpenAI SDK. Green against Python first, then flip the base URL.
- **The OpenAI API contract is the spec.** Where the port and the Python original disagree, the OpenAI API wins. Deviations get documented, not absorbed.

### Open questions

- [ ] Does ONNX Runtime Whisper hold up against the CTranslate2 INT8 baseline on our hardware? Blocks the Phase 4 Whisper swap. Needs a real benchmark, not a vibe check.
- [ ] Does diarization stay in Python permanently? `sherpa-onnx` supports it, but Pyannote is the quality reference and this is the least-used endpoint.
- [ ] Runtime validation library: Zod, Valibot, or ArkType. Matters because `types/realtime.py` is 673 lines of discriminated unions and this choice touches all of it.
- [ ] Do we keep the WebRTC endpoint at all, or is WebSocket sufficient for the clients we care about? `werift` is the `aiortc` replacement but is materially less battle-tested.
- [ ] Monorepo layout or a sibling directory? Affects whether Python and TypeScript share the repo root during Phases 2-3.

---

## Phase 0 — Scaffolding and seams

No behaviour yet. This phase exists to make every later phase mechanical.

- [ ] Scaffold SvelteKit with Svelte 5 (runes), TypeScript strict mode, Vite
- [ ] Choose and install the WebSocket-capable node adapter; prove a socket echoes in both `dev` and `build`
- [ ] Set up Vitest, ESLint, Prettier; wire into `.pre-commit-config.yaml` alongside the existing ruff hooks
- [ ] Port `src/speaches/config.py` to `src/lib/server/config.ts` — schema-validated env, including a replacement for pydantic's `__` nested-delimiter parsing
- [ ] Define `src/lib/server/executors/types.ts`: `TranscriptionExecutor`, `SpeechExecutor`, `VadExecutor`, `SpeakerEmbeddingExecutor`, `DiarizationExecutor`. Every method takes an `AbortSignal`
- [ ] Port the ref-counted TTL model manager from `executors/shared/base_model_manager.py` (drops the `threading.RLock` — Node is single-threaded)
- [ ] Stand up the worker-thread pool abstraction that executors will run inside
- [ ] Decide and document the directory layout for coexisting Python and TypeScript

**Done when:** `npm run dev` and `npm run build` both serve a page and hold a WebSocket open, and the executor interface compiles with zero implementations.

---

## Phase 1 — Playground, against the Python server

Replaces Gradio and the vendored React bundle. Talks to the existing Python server over its OpenAI-compatible API, so nothing on the backend changes.

- [ ] Hand-write `src/lib/types/realtime.ts` — the client/server event unions. This is the contract everything later depends on; start from the `openai` npm package's realtime types and add the Speachy extensions from `src/speaches/types/realtime.py`
- [ ] Shared API client with API-key handling (localStorage, matching current behaviour)
- [ ] Speech-to-text page, replacing `ui/tabs/stt.py` — file upload, streaming transcription over SSE, all five response formats
- [ ] Text-to-speech page, replacing `ui/tabs/tts.py` — model and voice pickers, speed, format, audio playback
- [ ] Audio chat page, replacing `ui/tabs/audio_chat.py` — mic capture, streaming text and audio reply
- [ ] Realtime console page, replacing `realtime-console/dist` — mic capture, WebSocket session, live transcript, VAD state indicator
- [ ] Raw event inspector on the realtime page (both directions, timestamped, filterable). The Python server already keeps every event in `EventPubSub.events`; this is the debugging tool that pays for itself across Phases 2 and 3
- [ ] Model management page — list local, browse registry, download with progress, delete
- [ ] Remove `gradio` from `pyproject.toml`, delete `src/speaches/ui/`, delete `realtime-console/`, drop the `StaticFiles` mount and `enable_ui` config from `main.py`

**Done when:** the SvelteKit app does everything the Gradio playground did, and the Gradio and React code is gone from the repo.

---

## Phase 2 — Test suite, then the HTTP surface

- [ ] Port `tests/` to Vitest against the OpenAI SDK, pointed at the Python server. Get green before writing a single handler
  - [ ] `openai_transcription_test.py`, `api_timestamp_granularities_test.py`, `openai_timestamp_granularities_test.py`
  - [ ] `speech_test.py`, `sse_test.py`
  - [ ] `api_model_test.py`, `model_manager_test.py`
  - [ ] `api_chat_test.py`
  - [ ] `auth_test.py`
  - [ ] `vad_test.py`, `speech_embedding_test.py`, `diarization_test.py`
  - [ ] `text_utils_test.py` (pure functions — port alongside `text_utils.ts`)
- [ ] Python inference worker: a narrow RPC surface over the existing executors, one method per executor interface method
- [ ] RPC-backed executor implementations in TypeScript
- [ ] Auth as a `handle` hook in `hooks.server.ts`, plus CORS and the `APIProxyError` handler from `main.py`
- [ ] Port `hf_utils.py` and `model_registry.py` using `@huggingface/hub`, including local cache scanning
- [ ] Port `audio.py` — PCM and WAV in-process, ffmpeg subprocess for mp3, opus, flac, aac
- [ ] Port `text_utils.py` — `SentenceChunker`, `strip_emojis`, `strip_markdown_emphasis`, SSE framing
- [ ] Implement the HTTP endpoints (see parity table below)
- [ ] Repoint the Vitest suite at the SvelteKit server; get green again
- [ ] Repoint the Phase 1 playground at the SvelteKit server

**Done when:** the ported test suite passes against SvelteKit, and the Python process is reachable only through the inference RPC.

---

## Phase 3 — The realtime session

The largest single chunk, and the part most worth doing carefully. Everything here comes from `src/speaches/realtime/`.

- [ ] `event-router.ts` from `event_router.py` — a `Map` plus discriminated-union narrowing, so a handler registered against the wrong event shape fails to compile
- [ ] `pubsub.ts` from `pubsub.py` — async-iterator subscribers
- [ ] `session-context.ts` from `context.py`
- [ ] `audio-buffer.ts` from `input_audio_buffer.py` — use a ring buffer; the original reallocates via `np.append` on every chunk
- [ ] Silero VAD on `onnxruntime-node`, in-process, from `executors/silero_vad_v5.py`
- [ ] `session-event-router.ts` from `session_event_router.py` — `session.update` and its field validation
- [ ] `input-audio-buffer-event-router.ts` from `input_audio_buffer_event_router.py` — append, commit, clear, and server-VAD turn detection
- [ ] `conversation-event-router.ts` from `conversation_event_router.py`
- [ ] `response-event-router.ts` from `response_event_router.py` — text, audio, and function-call response handlers over a chat-completion stream
- [ ] Message manager and WebSocket transport from `message_manager.py`
- [ ] Session lifecycle: 30-minute timeout, cancellation via `AbortController` where Python uses `asyncio.TaskGroup`
- [ ] Port `tests/realtime/realtime_conversation_test.py`
- [ ] WebRTC endpoint via `werift`, from `realtime_rtc.py` and `realtime/rtc/audio_stream_track.py` — pending the open question above
- [ ] Delete `src/speaches/realtime/` and `src/speaches/routers/`

**Done when:** Shape B is complete. Python is a model loader and nothing else.

---

## Phase 4 — Retire Python

One executor at a time, easiest and most verifiable first.

- [ ] Kokoro TTS on `sherpa-onnx` — verify by ear against the Python output
- [ ] Piper TTS on `sherpa-onnx`
- [ ] WeSpeaker speaker embedding on `sherpa-onnx`
- [ ] Benchmark ONNX Runtime Whisper against the CTranslate2 baseline; record the numbers here before deciding
- [ ] Whisper STT on `sherpa-onnx`, gated on that benchmark
- [ ] Parakeet STT on `sherpa-onnx`
- [ ] Pyannote diarization — port or consciously leave in Python
- [ ] GPU path: ONNX Runtime CUDA from Node, verified in Docker
- [ ] Rewrite the `Dockerfile` and compose files for a Node runtime
- [ ] Delete the Python inference worker, `pyproject.toml`, `uv.lock`, `flake.nix`
- [ ] Rewrite `README.md`, `mkdocs.yml`, and `docs/` for the new stack

**Done when:** one runtime, one lockfile, and a Dockerfile that fits on a screen.

---

## Endpoint parity

Tick when the endpoint is implemented in SvelteKit and its test passes.

| Endpoint | Source | Done |
| --- | --- | :---: |
| `POST /v1/audio/transcriptions` | `routers/stt.py` | [ ] |
| `POST /v1/audio/translations` | `routers/stt.py` | [ ] |
| `POST /v1/audio/speech` | `routers/speech.py` | [ ] |
| `POST /v1/audio/speech/timestamps` | `routers/vad.py` | [ ] |
| `POST /v1/audio/speech/embedding` | `routers/speech_embedding.py` | [ ] |
| `POST /v1/audio/diarization` | `routers/diarization.py` | [ ] |
| `POST /v1/chat/completions` | `routers/chat.py` | [ ] |
| `GET /v1/models` | `routers/models.py` | [ ] |
| `GET /v1/models/{model_id}` | `routers/models.py` | [ ] |
| `POST /v1/models/{model_id}` | `routers/models.py` | [ ] |
| `DELETE /v1/models/{model_id}` | `routers/models.py` | [ ] |
| `GET /v1/audio/models` | `routers/models.py` | [ ] |
| `GET /v1/audio/voices` | `routers/models.py` | [ ] |
| `GET /v1/registry` | `routers/models.py` | [ ] |
| `GET /api/ps` | `routers/misc.py` | [ ] |
| `POST /api/ps/{model_id}` | `routers/misc.py` | [ ] |
| `DELETE /api/ps/{model_id}` | `routers/misc.py` | [ ] |
| `GET /health` | `routers/misc.py` | [ ] |
| `WS /v1/realtime` | `routers/realtime_ws.py` | [ ] |
| `POST /v1/realtime` (WebRTC) | `routers/realtime_rtc.py` | [ ] |

---

## Module map

Reference for where each Python module lands.

| Python | TypeScript | Phase |
| --- | --- | --- |
| `config.py` | `lib/server/config.ts` | 0 |
| `dependencies.py` | module singletons + `hooks.server.ts` | 0, 2 |
| `main.py` | server entrypoint + `lib/server/bootstrap.ts` | 0 |
| `executors/shared/base_model_manager.py` | `lib/server/executors/model-manager.ts` | 0 |
| `executors/shared/handler_protocol.py` | `lib/server/executors/types.ts` | 0 |
| `types/realtime.py` | `lib/types/realtime.ts` | 1 |
| `types/chat.py` | `lib/types/chat.ts` | 2 |
| `api_types.py` | `lib/types/api.ts` | 2 |
| `ui/app.py`, `ui/tabs/*` | `routes/(playground)/**/+page.svelte` | 1 |
| `realtime-console/dist` | `routes/realtime/+page.svelte` | 1 |
| `audio.py` | `lib/server/audio.ts` | 2 |
| `text_utils.py` | `lib/server/text-utils.ts` | 2 |
| `hf_utils.py`, `model_registry.py` | `lib/server/hf.ts` | 2 |
| `routers/*.py` | `routes/v1/**/+server.ts` | 2 |
| `utils.py` | `lib/server/errors.ts` | 2 |
| `realtime/event_router.py` | `lib/server/realtime/event-router.ts` | 3 |
| `realtime/pubsub.py` | `lib/server/realtime/pubsub.ts` | 3 |
| `realtime/context.py` | `lib/server/realtime/session-context.ts` | 3 |
| `realtime/input_audio_buffer.py` | `lib/server/realtime/audio-buffer.ts` | 3 |
| `realtime/session.py` | `lib/server/realtime/session.ts` | 3 |
| `realtime/*_event_router.py` | `lib/server/realtime/*-event-router.ts` | 3 |
| `realtime/message_manager.py` | `lib/server/realtime/message-manager.ts` | 3 |
| `realtime/chat_utils.py` | `lib/server/realtime/chat-utils.ts` | 3 |
| `realtime/rtc/*` | `lib/server/realtime/rtc/*` (werift) | 3 |
| `executors/silero_vad_v5.py` | `lib/server/executors/vad.ts` | 3 |
| `executors/kokoro.py`, `piper.py` | `lib/server/executors/{kokoro,piper}.ts` | 4 |
| `executors/whisper.py`, `parakeet.py` | `lib/server/executors/{whisper,parakeet}.ts` | 4 |
| `executors/wespeaker_speaker_embedding.py` | `lib/server/executors/speaker-embedding.ts` | 4 |
| `executors/pyannote_diarization.py` | `lib/server/executors/diarization.ts` | 4 |
| `tracing.py` | `lib/server/tracing.ts` (OTel JS) | deferred |
| `logger.py` | `lib/server/logger.ts` | 0 |
| `packages/speaches-cli` | deferred | — |

---

## Out of scope

Named so they do not quietly creep in.

- Changing the API contract. This is a port; the OpenAI-compatible surface is preserved exactly.
- New models or new tasks beyond what the executor registry already covers.
- OpenTelemetry instrumentation, until Phase 3 is stable. The Python side has fourteen OTel packages; the port should not inherit that surface area before the core works.
- The `speaches-cli` package.
- Multi-tenancy, persistence, or a database. Sessions stay in memory, as they are today.
