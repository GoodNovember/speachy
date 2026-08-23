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

`INFERENCE_BACKEND` controls executor composition:

- `hybrid` (default) prefers compatible native executors and retains Python fallbacks.
- `native` exposes only Node-native tasks; it never starts the Python worker.
- `python` preserves the reference baseline.

The first native transcription model has the distinct ID `sherpa-onnx/whisper-tiny.en`. Its files are not interchangeable with the CTranslate2 files in `Systran/faster-whisper-tiny`. Provision the official sherpa artifact under `web/models/`:

```sh
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2 -o models/sherpa-onnx-whisper-tiny.en.tar.bz2
tar -xf models/sherpa-onnx-whisper-tiny.en.tar.bz2 -C models
```

Set `SPEACHY_SHERPA_WHISPER_MODEL_DIR` to use another location. The real native endpoint check is gated by `SPEACHY_RUN_NATIVE_TRANSCRIPTION_INTEGRATION=1`; the opt-in Python/native cold-and-warm comparison is gated by `SPEACHY_RUN_NATIVE_TRANSCRIPTION_BENCHMARK=1`.

The second native transcription model is the English-only Parakeet TDT v2 INT8 conversion, exposed as `sherpa-onnx/parakeet-tdt-0.6b-v2-int8`. It is distinct from the older `istupakov/parakeet-tdt` Hugging Face layout already understood by the Python-side catalog. Provision the official sherpa artifact under `web/models/`:

```sh
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2 -o models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
tar -xf models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2 -C models
```

The validated archive SHA-256 is `157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad`. The conversion derives from NVIDIA's `parakeet-tdt-0.6b-v2`, licensed CC BY 4.0. Set `SPEACHY_SHERPA_PARAKEET_MODEL_DIR` to use another location. Native model directories and benchmark output are local-only and ignored by Git.

Native speaker diarization uses the distinct bundle ID `sherpa-onnx/pyannote-segmentation-3.0+wespeaker-voxceleb-resnet34-LM`. It combines sherpa's Pyannote 3.0 segmentation ONNX with the English WeSpeaker VoxCeleb ResNet34-LM embedding ONNX and sherpa's fast clustering. This is not the cached `pyannote/speaker-diarization-community-1` pipeline, which retains its own VBx/PLDA clustering and remains the Python quality reference.

Provision both official release artifacts into one ignored directory:

```sh
mkdir -p models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 -o models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM/segmentation.tar.bz2
tar -xf models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM/segmentation.tar.bz2 -C models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM
cp models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM/sherpa-onnx-pyannote-segmentation-3-0/model.onnx models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM/segmentation.onnx
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx -o models/sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM/wespeaker_en_voxceleb_resnet34_LM.onnx
```

The validated SHA-256 values are `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488` for the segmentation archive, `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079` for the extracted segmentation ONNX, and `e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012` for the embedding ONNX. Each sherpa release model retains its upstream license; Pyannote segmentation 3.0 and WeSpeaker are separate upstream artifacts. Set `SPEACHY_SHERPA_DIARIZATION_MODEL_DIR` to use another location.

The opt-in real endpoint proof uses sherpa's official `1-two-speakers-en.wav` fixture by default. Put it in the bundle directory, set `SPEACHY_RUN_NATIVE_DIARIZATION_INTEGRATION=1`, and run `npx vitest run tests/integration/native-diarization.test.ts --maxWorkers=1`. `SPEACHY_SHERPA_DIARIZATION_AUDIO` can point to another local WAV. This proves the native HTTP contract and fixed speaker count; it is not a diarization-error-rate quality claim.

The opt-in long-form quality comparison uses a checked-in LibriVox provenance manifest and a curated Chapter 1 reference derived from the recording's [Project Gutenberg source text](https://www.gutenberg.org/ebooks/345). Audio is never copied into the repository: `SPEACHY_LONGFORM_CORPUS` must point to the machine-local directory containing the MP3. The harness requires the Python faster-whisper baseline and both native artifacts, runs all three sequentially with two model threads, and reports WER, edit counts, real-time factor, structural timestamp coverage, and native Node RSS. Python child-process memory and timestamp accuracy are explicitly left unmeasured.

Enable `SPEACHY_RUN_LONGFORM_TRANSCRIPTION_BENCHMARK=1` and run `npm run test:benchmark:longform`; versioned JSON evidence and a concise Markdown summary are written under ignored `web/test-results/`.

The first scored Chapter 1 run used 70 identical 29-second windows and a 5,828-word normalized reference. Parakeet produced 1.96% WER at RTF 0.147, native Whisper tiny.en produced 4.98% WER at RTF 0.161, and Python faster-whisper-tiny produced 14.04% WER at RTF 0.067. Parakeet is therefore the preferred native English model on this machine, trading roughly 1.35 GiB peak Node RSS for its quality lead; broader accents, noise conditions, and timestamp accuracy remain unmeasured.

The representative-corpus plan is serialized in [`tests/fixtures/evaluation/README.md`](tests/fixtures/evaluation/README.md). It defines a three-tier ladder—public-domain long-form reading, deterministic synthetic conversation mixtures, and a manually reviewed Internet Archive television-news subset—along with ownership, manifest, annotation, metric, and opt-in execution boundaries.

## ffmpeg

MP3, Opus, FLAC, and AAC encoding requires an ffmpeg executable. Install ffmpeg through the host operating system or container image and keep it on `PATH`; Linux and macOS therefore use the normal `ffmpeg` command without any platform-specific path. Set `FFMPEG_PATH` when the binary lives elsewhere.

On Windows, `FFMPEG_PATH` and an explicit encoder option still take precedence. If neither is set, the server checks the standard WinGet link before falling back to `PATH`. This avoids an obsolete ffmpeg bundled with another application shadowing the current installation. PCM and WAV do not invoke ffmpeg.
