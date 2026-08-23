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
- **ffmpeg is a hard runtime dependency, inherited by the port.** Every audio format except `pcm` is encoded by shelling out to ffmpeg with `-hide_banner`. A build too old to know that flag fails at stream time, which surfaces as a terminated connection rather than an error response — so it looks like a server bug. This bit us once already: a 2013 ffmpeg bundled with Panda3D sat earlier in the user PATH than the modern one. Fixed by reordering the user PATH; `run-reference.ps1` now checks the flag up front so a regression is obvious rather than mysterious. The TypeScript encoder is cross-platform: explicit path, then `FFMPEG_PATH`, then the standard WinGet link on Windows, then the normal `ffmpeg` PATH lookup used by Linux, macOS, and containers. PCM and WAV stay in-process.

- **The UI always talks to same-origin `/v1/*`, never to the reference directly.** In Phase 1, SvelteKit proxied `/v1/*` and `/api/*` because the reference sends no CORS headers. The UI was therefore already written against the exact paths our own server would serve. Phase 2 replaced every playground dependency with a native handler and removed the wildcard HTTP proxy; unknown compatibility paths now fail locally with the preserved `{"detail":"Not Found"}` shape.
- **The realtime WebSocket is proxied too, not just HTTP.** `src/lib/server/realtime/socket.ts` pipes `/v1/realtime` to the reference, so the browser still only talks to one origin and the console is written against the socket our own server will host in Phase 3. Frames sent before the upstream handshake completes are queued rather than dropped.
- **The reference needs `LOOPBACK_HOST_URL` set or realtime transcription silently fails.** Without it the session transcribes by calling itself through an in-process `ASGITransport(stt_router)`, which bypasses the middleware stack the endpoint needs and dies with `AssertionError: fastapi_middleware_astack not found in request scope` — reported to the client as a bare `APIConnectionError` with the item left at `transcript: null`. `dependencies.py` carries a `TODO: verify` on that code path; it does not work. `run-reference.ps1` sets it. Our Phase 3 session will call the transcription code directly and avoid the loopback entirely.
- **Always send an explicit `transcription_model` to the chat endpoint.** `model_aliases.json` maps the OpenAI default `whisper-1` to `Systran/faster-whisper-large-v3`, which is unlikely to be downloaded, so relying on the default either fails or silently pulls several gigabytes. `tts-1` maps to Kokoro, which is fine.
- **Our server takes port 8000; the reference moved to 8001.** 8000 is what every existing compose file and doc points at for the OpenAI-compatible API, and our server is the eventual drop-in replacement, so it should inherit that address rather than force a breaking change at the end of Phase 4.
- **SvelteKit's CSRF protection must stay off.** It rejects cross-site POSTs carrying form content types, which is exactly how `/v1/audio/transcriptions` is called. Every non-browser client — the OpenAI SDK, curl, the ported pytest suite — sends multipart with no matching `Origin` and gets a 403. Safe to disable here only because the API authenticates with an `Authorization` header and never cookies, so there is no ambient authority for CSRF to abuse. **If cookie or session auth is ever added, this must be revisited.** Found in the production build; the dev server did not surface it.
- **The Shape B Python worker uses buffered NDJSON over stdio.** It is a local child process, so a separate HTTP server adds ports, authentication, firewall behaviour, and deployment surface without buying isolation. Protocol v1 has request IDs, terminal results, structured errors, ordered streaming events, and explicit cooperative-cancellation messages. `src/speaches/inference_worker.py` owns the Python side; `web/src/lib/server/executors/python-worker.ts` owns process lifecycle and framing in Node.
- **Known-speaker diarization mapping remains reference-only for now.** The generic diarization executor returns timestamped speaker labels and supports an optional fixed speaker count. The Python HTTP route's `known_speaker_names[]` / `known_speaker_references[]` feature reaches through Pyannote's private embedding internals and has no pytest contract coverage. The native route returns an explicit 501 for those fields instead of silently ignoring them; preserving or dropping that extension is a separate compatibility decision.
- **An audio workspace is a user-selected, explicitly initialized directory.** The `Open Audio Workspace` button directly invokes `showDirectoryPicker({ mode: 'readwrite' })`; a root `speachy.workspace.json` file blesses the directory. Chromium gets read/write workspace support, while unsupported browsers degrade to read-only folder selection plus explicit downloads. Browser permission handles remain in IndexedDB and never enter the portable workspace.
- **Workspace identity, artifacts, browser state, and cache have separate owners.** `speachy.workspace.json` contains only versioned workspace identity and stable relative-path preferences. Audio and analysis files are portable reviewed artifacts. Directory permissions and last-open state are browser-local. Playhead and panel state are transient. Rebuildable waveform data is cache, not canonical workspace state.
- **The persistent inspector lives at `/workspace`; shared timeline primitives know neither folders nor sockets.** `/stt` remains a stateless one-file playground, `/mic` remains a capture check, and `/v1/*` remains the compatibility API. Waveform, capture, playhead, timed-annotation, speaker-lane, selection, and diagnostics modules accept both final batch results and provisional realtime updates without owning directory handles, IndexedDB, WebSockets, or artifact writes.

### Open questions

- [ ] Does ONNX Runtime Whisper hold up against the CTranslate2 INT8 baseline on our hardware? Blocks the Phase 4 Whisper swap. Needs a real benchmark, not a vibe check.
- [ ] Does diarization stay in Python permanently? `sherpa-onnx` supports it, but Pyannote is the quality reference and this is the least-used endpoint.
- [ ] Do we keep the WebRTC endpoint at all, or is WebSocket sufficient for the clients we care about? `werift` is the `aiortc` replacement but is materially less battle-tested.

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
- [x] Wire `npm run lint` and `npm test` into `.pre-commit-config.yaml` alongside the existing ruff hooks

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

## Phase 1 — Playground, against the Python server — COMPLETE

Replaces Gradio and the vendored React bundle. Talks to the existing Python server over its OpenAI-compatible API, so nothing on the backend changes.

Ordered so the uncertain work happens first. The audio capture and the event inspector are both prerequisites for everything below them, and the Gradio deletion is a one-way door held until the end.

- [x] **Browser audio capture.** `src/lib/audio/` — AudioWorklet capture, native resampling when the browser will open an AudioContext at 16 kHz and a linear-interpolation fallback when it will not, plus PCM16, WAV and base64 conversion. 23 unit tests cover the maths; the microphone itself needs a human, so `/mic` transcribes what it captured to turn the spike into a pass/fail
- [x] `src/lib/types/realtime.ts` — the client/server event unions, written from a session actually recorded by `scripts/capture-realtime.mjs` rather than from reading the source. Every object is loose so unmodelled fields survive, and `parseServerEvent` degrades instead of throwing on an unknown type
- [x] Shared API client with API-key handling (localStorage, reusing the Gradio storage key). Normalises FastAPI's error shapes; SSE parser does not wait for a `[DONE]` sentinel
- [x] **Raw event inspector**, on the realtime console: both directions, timestamped, filterable, expandable, with audio frames collapsed to a size so they do not drown the log
- [x] Speech-to-text page, replacing `ui/tabs/stt.py` — file upload, streaming over SSE, all five response formats, word timestamps, cancellation
- [x] Text-to-speech page, replacing `ui/tabs/tts.py` — model and voice pickers, speed, all six formats, playback and download
- [x] Model management page — local models, in-memory state, registry browse and filter, download, delete, unload
- [x] Audio chat page, replacing `ui/tabs/audio_chat.py` — speak or type, spoken reply, model and voice pickers. Chat models are listed by our own `/internal/chat-models` route rather than by the browser reaching the LLM backend directly. Streaming replies are not implemented yet; the request is non-streaming
- [x] Realtime console page, replacing `realtime-console/dist` — mic capture streamed as PCM16, live transcript, speech/silence indicator, event inspector
- [x] Removed `gradio` from `pyproject.toml`, deleted `src/speaches/ui/` and `realtime-console/`, dropped the `StaticFiles` mount and the `enable_ui` config. `uv sync` dropped gradio plus nine transitive dependencies; the reference server still starts and every smoke check still passes

**Done when:** the SvelteKit app does everything the Gradio playground did, and the Gradio and React code is gone from the repo.

**Status:** met, and then some. The playground had three tabs; the app has seven pages, adding a microphone capture check, a realtime console with an event inspector, and model management. `GET /` on the reference now returns 404, which is correct: the UI no longer lives there.

Not carried over: streaming replies on the audio chat page. The request is non-streaming, so the reply appears all at once. Worth doing when the response event router lands in Phase 3.

---

## Phase 2 — Test suite, then the HTTP surface

- [x] Port `tests/` to Vitest against the OpenAI SDK, pointed at the Python server. Green before writing a single handler. Lives in `web/tests/contract/`, runs with `npm run test:contract`, and targets whatever `SPEACHY_BASE_URL` points at so the same tests will verify our own server later. 44 tests, self-skipping when no server is listening
  - [x] `api_timestamp_granularities_test.py` — all five granularity combinations, and words present only when asked for. The two `openai_*` files are **not** ported: they hit the real OpenAI API rather than speaches
  - [x] `speech_test.py`, `sse_test.py` — wav/mp3/pcm headers, sse framing, srt and vtt parsed structurally with deliberately malformed input to prove the parsers are not vacuous
  - [x] `api_model_test.py` — list, filter by task, fetch by slashed id, 404 shape, voices, `/api/ps`. `model_manager_test.py` needs in-process config injection and is covered instead by the unit tests for `model-manager.ts`
  - [x] `api_chat_test.py` — text and spoken replies, both non-streaming and streaming; discovers the configured local chat backend model and accepts explicit environment overrides
  - [x] `auth_test.py` — ported as focused handle tests with injected enabled/disabled auth configuration
  - [x] `vad_test.py` — integer millisecond timestamps
  - [x] `speech_embedding_test.py`, `diarization_test.py` — finite 256-value embeddings, repeat-input similarity, JSON duration and segment bounds, RTTM structure, default response format, real-speech segments, and model-not-found behavior; verified against both the Python reference and the built SvelteKit server with the cached WeSpeaker and Pyannote Community-1 models
  - [x] `text_utils_test.py` (pure functions — ported alongside `text-utils.ts`, including coverage for the previously untested `SentenceChunker` and emoji stripping)
  - [x] `auth_test.py` — the SvelteKit handle factory accepts injected configuration, so enabled and disabled auth are covered without managing a second live process
- [x] Python inference worker: a narrow RPC surface over the existing executors, one method per executor interface method
  - [x] Buffered NDJSON transport and lifecycle methods: `ping`, `list_loaded`, `load_model`, `unload_model`; includes request IDs, structured errors, ordered events, cooperative cancellation, and a TypeScript lifecycle client
  - [x] Lazy shared worker lifecycle in the SvelteKit runtime, including protocol handshake, dev/production shutdown, and native `GET`/`POST`/`DELETE /api/ps` routes
  - [x] Executor methods: transcription/translation, speech streaming, speaker embedding, and diarization
    - [x] Non-streaming transcription with canonical little-endian Float32 audio, semantic JSON results, and lazy main-thread native-runtime initialization
    - [x] Non-streaming translation with Whisper-only executor selection and the shared semantic response codec
    - [x] Streaming transcription with ordered delta/done events, cooperative cancellation, terminal event-count validation, and accumulated terminal text
    - [x] Speech streaming with canonical Float32 audio events, terminal event-count validation, model-specific voice discovery, and consumer-driven cancellation
    - [x] VAD intentionally remains outside the worker; the in-process `onnxruntime-node` implementation is tracked in Phase 3
    - [x] Speaker embedding with canonical Float32 vector results and finite-value validation; fixture-verified and exercised against the cached WeSpeaker model through both the RPC adapter and native HTTP route
    - [x] Diarization with canonical Float32 audio, optional fixed speaker count, semantic timestamped segments, native-runtime main-thread preparation, and cooperative cancellation between returned tracks; fixture-verified and exercised offline against the cached Pyannote Community-1 pipeline
- [x] RPC-backed executor implementations in TypeScript
  - [x] Non-streaming Python transcription and translation adapter with request encoding, response validation, cancellation forwarding, and local-model catalog support
  - [x] Complete the Python transcription interface with validated streaming events and consumer-driven cancellation
  - [x] Python speech adapter with validated Float32 chunks, local-model voice lookup, and consumer-driven cancellation
  - [x] Python speaker embedding adapter with binary vector validation, cancellation forwarding, and local-model catalog support
  - [x] Python diarization adapter with validated timestamped segments, optional fixed speaker count, cancellation forwarding, and local-model catalog support
- [x] Auth as a `handle` hook in `hooks.server.ts`, plus CORS and the `APIProxyError` handler from `main.py`
- [x] Port `hf_utils.py` and `model_registry.py` using `@huggingface/hub`, including model-card filters, remote enumeration, local cache scanning, recursive file discovery, and guarded single-repository deletion
- [x] Port `audio.py` — PCM and WAV in-process, cancellable ffmpeg subprocess streaming for mp3, opus, flac, and aac
- [x] Port `text_utils.py` — `SentenceChunker`, `EOFTextChunker`, timestamp/subtitle formatting, `strip_emojis`, `strip_markdown_emphasis`, SSE framing
- [x] Implement the HTTP endpoints (see parity table below)
  - [x] Shared multipart audio decoding (PCM/WAV in-process, cancellable ffmpeg fallback), task-specific executor composition, and the native speaker-embedding route
  - [x] Native diarization route with JSON and RTTM responses, duration and filename semantics, model/decode/error validation, cancellation forwarding, and real cached-model contract parity
  - [x] Native transcription and translation routes with all five response formats, timestamp granularities and word-null semantics, streaming SSE and cancellation, validation/error boundaries, real cached-model contract parity, and shared in-process Silero VAD speech segments
  - [x] Native speech route with incremental PCM/WAV/ffmpeg formatting, PCM16 SSE events, model and voice selection, text cleanup, sample-rate conversion, eager validation before headers, cancellation, and cached Kokoro contract coverage. Missing ffmpeg now fails only the affected stream instead of hanging or terminating the Node server
  - [x] Native chat-completions route with input-audio transcription, configured OpenAI-compatible backend forwarding, buffered and streaming text/audio responses, transcript caching, validation, and end-to-end cached-model contract parity
- [x] Repoint the Vitest suite at the SvelteKit server; 44/44 contract tests pass against the built server in explicit cached-model offline mode
- [x] Repoint the Phase 1 playground at the SvelteKit server; every client call now resolves to a native handler, and the wildcard HTTP proxy has been removed. Only the explicitly tracked realtime WebSocket bridge remains for Phase 3

**Done when:** the ported test suite passes against SvelteKit, and the Python process is reachable only through the inference RPC.

---

## Phase 2.5 — Audio workspace and inspection rig

This is the acceptance surface for the native transcription and diarization endpoints, not a separate demo. It keeps the original audio, raw inference responses, derived alignment, browser permissions, and transient UI state in distinct ownership domains.

- [x] Add `/workspace` as a dedicated application route, distinct from the stateless `/stt` and `/mic` playgrounds and from the `/v1/*` API surface
- [x] Define and validate `speachy.workspace.json` v1 with `kind`, `schemaVersion`, stable workspace `id`, display `name`, and relative `recordingsDirectory` / `analysisDirectory` paths
  - [x] Keep absolute paths, permission handles, volatile timestamps, file indexes, caches, and transient UI state out of the manifest
  - [x] Reject malformed manifests without mutation; open a workspace with a newer schema read-only instead of overwriting it
- [x] Add `Open Audio Workspace` as the direct user gesture for read/write directory selection
  - [x] If no manifest exists, offer an explicit `Initialize Workspace` action before writing it
  - [x] Persist the granted directory handle in IndexedDB keyed by workspace ID; query or request permission again when the browser requires it
  - [x] Feature-detect `showDirectoryPicker`; fall back to read-only directory input where directory writes are unavailable
  - [ ] In fallback mode, offer new recordings and generated artifacts as downloads when those producers land below
- [x] Enumerate supported audio files and expose explicit refresh, selected-file, unprocessed, ready, stale, and failed states without requiring a filesystem watcher — recursive File System Access and read-only folder inventories share one deterministic filter; refresh preserves analysis state for unchanged files and marks changed source audio stale
- [ ] Build the inspection timeline fixture-first, then connect it to the same-origin APIs
  - [ ] Define a transport- and storage-neutral timed-annotation model that can add, revise, and finalize transcript words, transcript segments, and speaker turns instead of assuming immutable completed arrays
  - [ ] Browser-decoded waveform and native audio playback share one seekable playhead
  - [ ] Transcription segments and words align horizontally by timestamp
  - [ ] Diarization renders one lane per speaker so overlaps remain visible; speaker labels map deterministically into a small accessible palette and remain visible as text
  - [ ] Clicking a word seeks to it; clicking a speaker turn selects or loops that interval
  - [ ] Surface gaps, overlaps, out-of-range timestamps, duration mismatches, and words crossing speaker boundaries without rewriting the source responses
- [ ] Derive word-to-speaker assignments by temporal overlap while preserving transcription and diarization responses unchanged; mark ambiguous boundary cases explicitly
- [ ] Record mono PCM WAV into the configured recordings directory using collision-safe timestamped filenames, then select it and optionally analyze it
- [ ] Write versioned analysis artifacts into the configured analysis directory
  - [ ] Preserve raw transcription and diarization payloads as canonical results
  - [ ] Store derived alignment and diagnostics separately from those payloads
  - [ ] Record audio filename, size, modification time, duration, content hash, model IDs, and analysis time so stale results are detectable and runs are reproducible

**Done when:** a user can initialize or reopen a portable workspace, inspect existing audio, record a new WAV into it, run transcription and diarization, review their shared timeline, and reopen the generated artifacts without any server-side database.

---

## Phase 3 — The realtime session

The largest single chunk, and the part most worth doing carefully. Everything here comes from `src/speaches/realtime/`.

- [ ] `event-router.ts` from `event_router.py` — a `Map` plus discriminated-union narrowing, so a handler registered against the wrong event shape fails to compile
- [ ] `pubsub.ts` from `pubsub.py` — async-iterator subscribers
- [ ] `session-context.ts` from `context.py`
- [ ] `audio-buffer.ts` from `input_audio_buffer.py` — use a ring buffer; the original reallocates via `np.append` on every chunk
- [x] Silero VAD on `onnxruntime-node`, in-process, from `executors/silero_vad_v5.py`
- [ ] `session-event-router.ts` from `session_event_router.py` — `session.update` and its field validation
- [ ] `input-audio-buffer-event-router.ts` from `input_audio_buffer_event_router.py` — append, commit, clear, and server-VAD turn detection
- [ ] `conversation-event-router.ts` from `conversation_event_router.py`
- [ ] `response-event-router.ts` from `response_event_router.py` — text, audio, and function-call response handlers over a chat-completion stream
- [ ] Message manager and WebSocket transport from `message_manager.py`
- [ ] Session lifecycle: 30-minute timeout, cancellation via `AbortController` where Python uses `asyncio.TaskGroup`
- [ ] Reuse the Phase 2.5 capture, waveform, playhead, timed-annotation, speaker-lane, selection, and diagnostics primitives for provisional realtime state; keep the `/realtime` route responsible only for session and transport ownership
- [ ] Add an explicit `Save Session to Workspace` transition that writes the captured WAV and the same versioned analysis artifact used by batch inspection; realtime remains in memory until the user chooses to save
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
| `POST /v1/audio/transcriptions`    | `routers/stt.py`              | [x]  |
| `POST /v1/audio/translations`      | `routers/stt.py`              | [x]  |
| `POST /v1/audio/speech`            | `routers/speech.py`           | [x]  |
| `POST /v1/audio/speech/timestamps` | `routers/vad.py`              | [x]  |
| `POST /v1/audio/speech/embedding`  | `routers/speech_embedding.py` | [x]  |
| `POST /v1/audio/diarization`       | `routers/diarization.py`      | [x]  |
| `POST /v1/chat/completions`        | `routers/chat.py`             | [x]  |
| `GET /v1/models`                   | `routers/models.py`           | [x]  |
| `GET /v1/models/{model_id}`        | `routers/models.py`           | [x]  |
| `POST /v1/models/{model_id}`       | `routers/models.py`           | [x]  |
| `DELETE /v1/models/{model_id}`     | `routers/models.py`           | [x]  |
| `GET /v1/audio/models`             | `routers/models.py`           | [x]  |
| `GET /v1/audio/voices`             | `routers/models.py`           | [x]  |
| `GET /v1/registry`                 | `routers/models.py`           | [x]  |
| `GET /api/ps`                      | `routers/misc.py`             | [x]  |
| `POST /api/ps/{model_id}`          | `routers/misc.py`             | [x]  |
| `DELETE /api/ps/{model_id}`        | `routers/misc.py`             | [x]  |
| `GET /health`                      | `routers/misc.py`             | [x]  |
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
| `audio.py`                                 | `src/lib/server/audio.ts`                         | 2 done   |
| `text_utils.py`                            | `src/lib/server/text-utils.ts`                    | 2        |
| `hf_utils.py`, `model_registry.py`         | `src/lib/server/hf.ts` + `model-registry.ts`      | 2 done   |
| `routers/*.py`                             | `src/routes/v1/**/+server.ts`                     | 2        |
| `utils.py`                                 | `src/lib/server/errors.ts`                        | 2 done   |
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
- Multi-tenancy or server-side database persistence. Phase 2.5 local workspace files are deliberately in scope; inference sessions stay in memory, as they are today.
