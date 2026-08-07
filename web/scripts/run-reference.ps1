# Starts the Python reference server on CPU, which the port is validated against.
#
#   pwsh web/scripts/run-reference.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Every audio format except pcm is encoded by shelling out to ffmpeg with
# -hide_banner. A build too old to know that flag fails at stream time, which
# surfaces as a terminated connection rather than an error response, so check
# it up front instead of letting it look like a server bug.
$ffmpeg = Get-Command ffmpeg -EA SilentlyContinue
if ($null -eq $ffmpeg) {
	throw "ffmpeg not found on PATH. Install it (winget install Gyan.FFmpeg) or /v1/audio/speech will only work with response_format=pcm."
}
& $ffmpeg.Source -hide_banner -version *> $null
if ($LASTEXITCODE -ne 0) {
	throw "ffmpeg at $($ffmpeg.Source) does not support -hide_banner, so it is too old. Ensure a modern ffmpeg resolves before it on PATH."
}

$env:WHISPER__INFERENCE_DEVICE = 'cpu'
$env:WHISPER__COMPUTE_TYPE = 'int8'
$env:ENABLE_UI = 'false'
$env:LOG_LEVEL = 'info'

# Without this the realtime session transcribes by calling itself through an
# in-process ASGITransport, which bypasses the middleware stack the endpoint
# needs and dies with "fastapi_middleware_astack not found in request scope",
# reported to the client as a bare APIConnectionError. Setting a loopback URL
# makes it use real HTTP instead. dependencies.py carries a TODO doubting that
# code path; it is in fact broken.
$env:LOOPBACK_HOST_URL = 'http://127.0.0.1:8001'

Write-Host "ffmpeg:  $($ffmpeg.Source)"
Write-Host "repo:    $repoRoot"
Write-Host "Serving on http://127.0.0.1:8001 (Ctrl-C to stop)`n"
Write-Host "(8000 is reserved for the SvelteKit server, which replaces this one)`n"

Set-Location $repoRoot
uv run uvicorn --factory --host 127.0.0.1 --port 8001 speaches.main:create_app
