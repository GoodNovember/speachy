# Silero VAD v5 model assets

These ONNX encoder and decoder files are the Silero VAD v5 assets distributed
with `faster-whisper`. They are now owned by the Node runtime so the in-process
VAD does not depend on the Python virtualenv. The executor accepts
`SPEACHY_VAD_MODEL_DIR` as a deployment-time override.

- Upstream project: <https://github.com/snakers4/silero-vad>
- Asset source: `faster_whisper.utils.get_assets_path()`
- License: MIT
