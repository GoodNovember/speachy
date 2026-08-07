# Roadmap: Speachy on Svelte / SvelteKit

Porting this fork from Python + FastAPI to TypeScript + SvelteKit.

**How to use this document.** Phases are ordered by dependency, not by preference — each one leaves the project in a runnable state. Tick items as they land. When an open question below gets answered, move it to the decision log with a one-line rationale so the reasoning survives.

Companion design doc (rationale, architecture, transposition detail): https://claude.ai/code/artifact/a8eeab18-05e5-4227-8cee-54bc07a47eb1

---

## Target architecture

Three shapes, same destination at three distances. We build toward **Shape B** and design so that **Shape C** is cheap.

| Shape | Control plane                           | Inference                       | Status    |
| ----- | --------------------------------------- | ------------------------------- | --------- |
| A     | SvelteKit UI only                       | Python (unchanged)              | Phase 1   |
| B     | SvelteKit (API, realtime, registry, UI) | Python worker behind RPC        | Phase 2-3 |
| C     | SvelteKit                               | `sherpa-onnx` in worker threads | Phase 4   |

The seam that makes B to C cheap is a single executor interface. Fix it in Phase 0 and never let a route file import an executor implementation directly.

---

## Decision log

Locked decisions. Add to this as open questions resolve.

- **Adapter: official `adapter-node` plus our own listener.** Revised during Phase 0. The plan was to start with a community WebSocket adapter, but `adapter-node-ws` is not published to npm and `@mdd95/sveltekit-adapter-node` is at 1.1.0 — too thin a dependency for the critical path. Instead: official `@sveltejs/adapter-node`, a `src/server-entry.ts` that owns the HTTP listener and mounts SvelteKit's handler as the fallback, and a Vite plugin that attaches the same socket in dev. Only first-party pieces, and no framework-version risk.
- **Cross-bundle state lives on `globalThis`.** The server entry and SvelteKit's handler are separate bundles, so a module-level singleton would be instantiated twice. `src/lib/server/runtime.ts` keeps the one instance behind `Symbol.for('speachy.runtime')`, which both bundles resolve to. This is what makes the split listener safe.
- **The web app lives in `web/`, not the repo root.** `src/` is already the Python package, and SvelteKit wants `src/routes` and `src/lib`. The directory gets promoted to the root in Phase 4 when Python goes away.
- **Zod for runtime validation.** Largest ecosystem, and its discriminated unions map cleanly onto the tagged unions in `types/realtime.py`. Note that `.default()` returns its value unparsed — nested defaults need `.prefault()`.
- **Inference runs in `worker_threads`, always.** `sherpa-onnx` calls are synchronous native calls that block the event loop. Python gets away with threads because native code releases the GIL; Node has no equivalent escape. This is architectural, not an optimisation — retrofitting it means rewriting every executor signature.
- **Silero VAD stays in-process.** Turn detection sits in the latency path of every realtime turn and cannot afford an RPC round trip. It runs on `onnxruntime-node` in the main process even during Shape B.
- **Port the test suite before the implementation.** The 16 pytest files are an executable specification of the API contract, written against the OpenAI SDK. Green against Python first, then flip the base URL.
- **The OpenAI API contract is the spec.** Where the port and the Python original disagree, the OpenAI API wins. Deviations get documented, not absorbed. The observed ones are in [`web/tests/fixtures/python-reference/FINDINGS.md`](web/tests/fixtures/python-reference/FINDINGS.md) — read that before implementing any endpoint, because several contradict what the source reads like.
- **The reference server runs CPU-only, and that is the target.** `uv sync` installs the CPU builds of torch and onnxruntime on this hardware, so `WHISPER__INFERENCE_DEVICE=cpu` and `WHISPER__COMPUTE_TYPE=int8` are all that is needed. Start it with `pwsh web/scripts/run-reference.ps1`. CUDA is a later concern, gated on better hardware.
- **ffmpeg is a hard runtime dependency, inherited by the port.** Every audio format except `pcm` is encoded by shelling out to ffmpeg with `-hide_banner`. A build too old to know that flag fails at stream time, which surfaces as a terminated connection rather than an error response — so it looks like a server bug. This bit us once already: a 2013 ffmpeg bundled with Panda3D sat earlier in the user PATH than the modern one. Fixed by reordering the user PATH; `run-reference.ps1` now checks the flag up front so a regression is obvious rather than mysterious.

- **The UI always talks to same-origin `/v1/*`, never to the reference directly.** The reference sends no CORS headers, and rather than weaken its config with `ALLOW_ORIGINS`, SvelteKit proxies `/v1/*` and `/api/*` to it (`src/lib/server/proxy.ts`). The UI is therefore written against the exact paths our own server will serve, so Phase 2 replaces proxied routes one at a time with no UI changes. The proxy streams bodies through rather than buffering, so SSE and audio still arrive incrementally.
- **The realtime WebSocket is proxied too, not just HTTP.** `src/lib/server/realtime/socket.ts` pipes `/v1/realtime` to the reference, so the browser still only talks to one origin and the console is written against the socket our own server will host in Phase 3. Frames sent before the upstream handshake completes are queued rather than dropped.
- **The reference needs `LOOPBACK_HOST_URL` set or realtime transcription silently fails.** Without it the session transcribes by calling itself through an in-process `ASGITransport(stt_router)`, which bypasses the middleware stack the endpoint needs and dies with `AssertionError: fastapi_middleware_astack not found in request scope` — reported to the client as a bare `APIConnectionError` with the item left at `transcript: null`. `dependencies.py` carries a `TODO: verify` on that code path; it does not work. `run-reference.ps1` sets it. Our Phase 3 session will call the transcription code directly and avoid the loopback entirely.
- **SvelteKit's CSRF protection must stay off.** It rejects cross-site POSTs carrying form content types, which is exactly how `/v1/audio/transcriptions` is called. Every non-browser client — the OpenAI SDK, curl, the ported pytest suite — sends multipart with no matching `Origin` and gets a 403. Safe to disable here only because the API authenticates with an `Authorization` header and never cookies, so there is no ambient authority for CSRF to abuse. **If cookie or session auth is ever added, this must be revisited.** Found in the production build; the dev server did not surface it.

### Open questions

- [ ] Does ONNX Runtime Whisper hold up against the CTranslate2 INT8 baseline on our hardware? Blocks the Phase 4 Whisper swap. Needs a real benchmark, not a vibe check.
- [ ] Does diarization stay in Python permanently? `sherpa-onnx` supports it, but Pyannote is the quality reference and this is the least-used endpoint.
- [ ] Do we keep the WebRTC endpoint at all, or is WebSocket sufficient for the clients we care about? `werift` is the `aiortc` replacement but is materially less battle-tested.
- [ ] How does the Python inference worker talk to Node in Phases 2-3 — stdio JSON-RPC, a Unix socket, or a local HTTP server? Streaming TTS chunks and cancellation are the two things that decide it.

---

## Phase 0 — Scaffolding and seams — COMPLETE

No behaviour yet. This phase exists to make every later phase mechanical. Everything lives in `web/`.

- [x] Scaffold SvelteKit with Svelte 5 (runes), TypeScript strict mode, Vite
- [x] Settle the WebSocket story and prove a socket echoes in both `dev` and `build` — `web/src/lib/server/realtime/socket.ts`, attached by `web/vite-plugin-realtime.ts` in dev and `web/src/server-entry.ts` in production
- [x] Verify the realtime socket coexists with Vite's HMR socket on the same port
- [x] Set up Vitest, ESLint, Prettier
- [x] Port `src/speaches/config.py` to `web/src/lib/server/config.ts` — schema-validated env, including a replacement for pydantic's `__` nested-delimiter parsing and the `UVICORN_HOST`/`UVICORN_PORT` names
- [x] Define `web/src/lib/server/executors/types.ts`: `TranscriptionExecutor`, `SpeechExecutor`, `VadExecutor`, `SpeakerEmbeddingExecutor`, `DiarizationExecutor`. Every method takes an `AbortSignal`
- [x] Port the ref-counted TTL model manager from `executors/shared/base_model_manager.py` (drops the `threading.RLock` — Node is single-threaded)
- [x] Stand up the worker-thread pool abstraction that executors will run inside, with cancellation and streaming
- [x] Decide and document the directory layout for coexisting Python and TypeScript
- [x] `web/scripts/smoke.mjs` — re-runnable acceptance check for the page and the socket
- [ ] Wire `npm run lint` and `npm test` into `.pre-commit-config.yaml` alongside the existing ruff hooks

**Done when:** `npm run dev` and `npm run build` both serve a page and hold a WebSocket open, and the executor interface compiles with zero implementations.

**Status:** met. 40 unit tests pass, `svelte-check` and ESLint are clean, and `scripts/smoke.mjs` passes against both the dev server and the built server.

```
cd web
npm test                                   # 40 tests
npm run check && npm run lint              # types and lint
npm run build && npm start                 # production server on :8000
node scripts/smoke.mjs http://127.0.0.1:8000
```

---

## Phase 0.5 — Get the reference running — COMPLETE

The port is validated against the Python server, so it has to actually run. It never had on this machine.

- [x] Install `uv`, let it fetch Python 3.12 (`pyproject.toml` pins `==3.12.*`; the system had 3.13)
- [x] `uv sync` — CPU builds of torch and onnxruntime, no CUDA handling needed
- [x] Install a modern ffmpeg; diagnose the Panda3D build shadowing it on the machine PATH
- [x] Download `Systran/faster-whisper-tiny` and `speaches-ai/Kokoro-82M-v1.0-ONNX`
- [x] `web/scripts/run-reference.ps1` — one command to start the reference on CPU
- [x] `web/scripts/capture-reference.mjs` — capture real responses from every endpoint
- [x] Document the observed behaviour in `web/tests/fixtures/python-reference/FINDINGS.md`

**Found by running it, not by reading it:** no `[DONE]` sentinel on SSE streams; `transcript.text.done` reports an empty transcript; errors use FastAPI's `{"detail": ...}` rather than OpenAI's error envelope; an invalid TTS speed terminates the connection instead of returning 422; streaming WAV carries a `0xFFFFFFFF` placeholder RIFF size. Full detail in FINDINGS.md.

---

## Phase 1 — Playground, against the Python server

Replaces Gradio and the vendored React bundle. Talks to the existing Python server over its OpenAI-compatible API, so nothing on the backend changes.

Ordered so the uncertain work happens first. The audio capture and the event inspector are both prerequisites for everything below them, and the Gradio deletion is a one-way door held until the end.

- [x] **Browser audio capture.** `src/lib/audio/` — AudioWorklet capture, native resampling when the browser will open an AudioContext at 16 kHz and a linear-interpolation fallback when it will not, plus PCM16, WAV and base64 conversion. 23 unit tests cover the maths; the microphone itself needs a human, so `/mic` transcribes what it captured to turn the spike into a pass/fail
- [x] `src/lib/types/realtime.ts` — the client/server event unions, written from a session actually recorded by `scripts/capture-realtime.mjs` rather than from reading the source. Every object is loose so unmodelled fields survive, and `parseServerEvent` degrades instead of throwing on an unknown type
- [x] Shared API client with API-key handling (localStorage, reusing the Gradio storage key). Normalises FastAPI's error shapes; SSE parser does not wait for a `[DONE]` sentinel
- [x] **Raw event inspector**, on the realtime console: both directions, timestamped, filterable, expandable, with audio frames collapsed to a size so they do not drown the log
- [x] Speech-to-text page, replacing `ui/tabs/stt.py` — file upload, streaming over SSE, all five response formats, word timestamps, cancellation
- [x] Text-to-speech page, replacing `ui/tabs/tts.py` — model and voice pickers, speed, all six formats, playback and download
- [x] Model management page — local models, in-memory state, registry browse and filter, download, delete, unload
- [ ] Audio chat page, replacing `ui/tabs/audio_chat.py` — mic capture, streaming text and audio reply. Needs a chat backend at `chat_completion_base_url` (Ollama by default), which is not yet running here
- [x] Realtime console page, replacing `realtime-console/dist` — mic capture streamed as PCM16, live transcript, speech/silence indicator, event inspector
- [ ] Remove `gradio` from `pyproject.toml`, delete `src/speaches/ui/`, delete `realtime-console/`, drop the `StaticFiles` mount and `enable_ui` config from `main.py`. **Its own commit** — this deletes the reference UI, so it must stay trivially revertible

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

| Endpoint                           | Source                        | Done |
| ---------------------------------- | ----------------------------- | :--: |
| `POST /v1/audio/transcriptions`    | `routers/stt.py`              | [ ]  |
| `POST /v1/audio/translations`      | `routers/stt.py`              | [ ]  |
| `POST /v1/audio/speech`            | `routers/speech.py`           | [ ]  |
| `POST /v1/audio/speech/timestamps` | `routers/vad.py`              | [ ]  |
| `POST /v1/audio/speech/embedding`  | `routers/speech_embedding.py` | [ ]  |
| `POST /v1/audio/diarization`       | `routers/diarization.py`      | [ ]  |
| `POST /v1/chat/completions`        | `routers/chat.py`             | [ ]  |
| `GET /v1/models`                   | `routers/models.py`           | [ ]  |
| `GET /v1/models/{model_id}`        | `routers/models.py`           | [ ]  |
| `POST /v1/models/{model_id}`       | `routers/models.py`           | [ ]  |
| `DELETE /v1/models/{model_id}`     | `routers/models.py`           | [ ]  |
| `GET /v1/audio/models`             | `routers/models.py`           | [ ]  |
| `GET /v1/audio/voices`             | `routers/models.py`           | [ ]  |
| `GET /v1/registry`                 | `routers/models.py`           | [ ]  |
| `GET /api/ps`                      | `routers/misc.py`             | [ ]  |
| `POST /api/ps/{model_id}`          | `routers/misc.py`             | [ ]  |
| `DELETE /api/ps/{model_id}`        | `routers/misc.py`             | [ ]  |
| `GET /health`                      | `routers/misc.py`             | [ ]  |
| `WS /v1/realtime`                  | `routers/realtime_ws.py`      | [ ]  |
| `POST /v1/realtime` (WebRTC)       | `routers/realtime_rtc.py`     | [ ]  |

---

## Module map

Reference for where each Python module lands. All TypeScript paths are relative to `web/`.

| Python                                     | TypeScript                                        | Phase    |
| ------------------------------------------ | ------------------------------------------------- | -------- |
| `config.py`                                | `src/lib/server/config.ts`                        | 0 done   |
| `logger.py`                                | `src/lib/server/logger.ts`                        | 0 done   |
| `main.py` lifespan                         | `src/lib/server/bootstrap.ts`                     | 0 done   |
| `main.py` create_app                       | `src/server-entry.ts` + `vite-plugin-realtime.ts` | 0 done   |
| `dependencies.py` lru_cache singletons     | `src/lib/server/runtime.ts`                       | 0 done   |
| `executors/shared/base_model_manager.py`   | `src/lib/server/executors/model-manager.ts`       | 0 done   |
| `executors/shared/handler_protocol.py`     | `src/lib/server/executors/types.ts`               | 0 done   |
| (no counterpart - Node needs it)           | `src/lib/server/executors/worker-pool.ts`         | 0 done   |
| `dependencies.py` Depends                  | `src/hooks.server.ts`                             | 2        |
| `types/realtime.py`                        | `src/lib/types/realtime.ts`                       | 1        |
| `types/chat.py`                            | `src/lib/types/chat.ts`                           | 2        |
| `api_types.py`                             | `src/lib/types/api.ts`                            | 2        |
| `ui/app.py`, `ui/tabs/*`                   | `src/routes/(playground)/**/+page.svelte`         | 1        |
| `realtime-console/dist`                    | `src/routes/realtime/+page.svelte`                | 1        |
| `audio.py`                                 | `src/lib/server/audio.ts`                         | 2        |
| `text_utils.py`                            | `src/lib/server/text-utils.ts`                    | 2        |
| `hf_utils.py`, `model_registry.py`         | `src/lib/server/hf.ts`                            | 2        |
| `routers/*.py`                             | `src/routes/v1/**/+server.ts`                     | 2        |
| `utils.py`                                 | `src/lib/server/errors.ts`                        | 2        |
| `realtime/event_router.py`                 | `src/lib/server/realtime/event-router.ts`         | 3        |
| `realtime/pubsub.py`                       | `src/lib/server/realtime/pubsub.ts`               | 3        |
| `realtime/context.py`                      | `src/lib/server/realtime/session-context.ts`      | 3        |
| `realtime/input_audio_buffer.py`           | `src/lib/server/realtime/audio-buffer.ts`         | 3        |
| `realtime/session.py`                      | `src/lib/server/realtime/session.ts`              | 3        |
| `realtime/*_event_router.py`               | `src/lib/server/realtime/*-event-router.ts`       | 3        |
| `realtime/message_manager.py`              | `src/lib/server/realtime/message-manager.ts`      | 3        |
| `realtime/chat_utils.py`                   | `src/lib/server/realtime/chat-utils.ts`           | 3        |
| `realtime/rtc/*`                           | `src/lib/server/realtime/rtc/*` (werift)          | 3        |
| `executors/silero_vad_v5.py`               | `src/lib/server/executors/vad.ts`                 | 3        |
| `executors/kokoro.py`, `piper.py`          | `src/lib/server/executors/{kokoro,piper}.ts`      | 4        |
| `executors/whisper.py`, `parakeet.py`      | `src/lib/server/executors/{whisper,parakeet}.ts`  | 4        |
| `executors/wespeaker_speaker_embedding.py` | `src/lib/server/executors/speaker-embedding.ts`   | 4        |
| `executors/pyannote_diarization.py`        | `src/lib/server/executors/diarization.ts`         | 4        |
| `tracing.py`                               | `src/lib/server/tracing.ts` (OTel JS)             | deferred |
| `packages/speaches-cli`                    | deferred                                          | —        |

---

## Out of scope

Named so they do not quietly creep in.

- Changing the API contract. This is a port; the OpenAI-compatible surface is preserved exactly.
- New models or new tasks beyond what the executor registry already covers.
- OpenTelemetry instrumentation, until Phase 3 is stable. The Python side has fourteen OTel packages; the port should not inherit that surface area before the core works.
- The `speaches-cli` package.
- Multi-tenancy, persistence, or a database. Sessions stay in memory, as they are today.
