# speachy web

The SvelteKit port of Speachy. See [`../ROADMAP.md`](../ROADMAP.md) for what is built and what is next.

This lives in `web/` rather than the repo root because `src/` is already the Python package and SvelteKit needs `src/routes` and `src/lib`. It gets promoted to the root in Phase 4, when Python goes away.

## Commands

```
npm install
npm run dev                                  # dev server, realtime socket included
npm test                                     # unit tests
npm run check                                # svelte-check
npm run lint                                 # prettier + eslint
npm run format                               # prettier --write
npm run build                                # client bundle, then the standalone server
npm start                                    # run the built server
node scripts/smoke.mjs http://127.0.0.1:8000 # page + socket acceptance check
```

## How the server is put together

SvelteKit has no first-class WebSocket support, and the realtime session is the core of this project, so the HTTP listener is ours rather than the adapter's.

- `src/server-entry.ts` owns the listener in production. It attaches the realtime WebSocket and mounts SvelteKit's `handler` as the fallback route.
- `vite-plugin-realtime.ts` attaches the same socket to Vite's dev server, so both modes run identical code.
- `src/lib/server/realtime/socket.ts` only claims upgrades on `/v1/realtime` and leaves everything else alone, which is what keeps Vite's HMR socket working on the same port.

Those two entrypoints are separate bundles, so a module-level singleton would exist twice. `src/lib/server/runtime.ts` holds the single instance behind a registered symbol on `globalThis`, and `bootstrap()` is idempotent so whichever entrypoint runs first wins.

## Where the boundaries are

`src/lib/server/executors/types.ts` is the seam that keeps the port's later phases cheap. A Python RPC client and a `sherpa-onnx` worker are both just implementations of those interfaces. **Nothing outside `src/lib/server/executors/` may import a concrete executor**, and every method takes an `AbortSignal` so a hung-up caller actually stops inference.

Inference always runs inside `src/lib/server/executors/worker-pool.ts`. Native inference calls block the thread they run on and Node has no GIL to release, so this is architectural rather than an optimisation.

## Configuration

`src/lib/server/config.ts` reads the same environment variables as the Python server, including pydantic's `WHISPER__COMPUTE_TYPE` nested form and the `UVICORN_HOST` / `UVICORN_PORT` names. Lists accept both the JSON form (`ALLOW_ORIGINS='["*"]'`) and a plain comma-separated list.

During Shape B, the server resolves the repository's `.venv` automatically and starts the inference worker from the repository root so `speaches.inference_worker` is importable in both development and production builds. Set `SPEACHY_PYTHON` to override the Python executable when using a different synced environment.

## ffmpeg

MP3, Opus, FLAC, and AAC encoding requires an ffmpeg executable. Install ffmpeg through the host operating system or container image and keep it on `PATH`; Linux and macOS therefore use the normal `ffmpeg` command without any platform-specific path. Set `FFMPEG_PATH` when the binary lives elsewhere.

On Windows, `FFMPEG_PATH` and an explicit encoder option still take precedence. If neither is set, the server checks the standard WinGet link before falling back to `PATH`. This avoids an obsolete ffmpeg bundled with another application shadowing the current installation. PCM and WAV do not invoke ffmpeg.
