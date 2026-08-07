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

Write-Host "ffmpeg:  $($ffmpeg.Source)"
Write-Host "repo:    $repoRoot"
Write-Host "Serving on http://127.0.0.1:8000 (Ctrl-C to stop)`n"

Set-Location $repoRoot
uv run uvicorn --factory --host 127.0.0.1 --port 8000 speaches.main:create_app
