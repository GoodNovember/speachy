# Starts the Python reference server on CPU, which the port is validated against.
#
#   pwsh web/scripts/run-reference.ps1
#
# The ffmpeg on this machine's machine-level PATH is a 2013 build shipped with
# Panda3D that predates -hide_banner, and it shadows the modern one installed
# under the winget links directory. Prepending here fixes it for this process
# only, without touching the user's persistent PATH. Without it, every audio
# format except pcm fails with a terminated connection.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
$uvBin = Join-Path $env:USERPROFILE '.local\bin'

$env:PATH = "$wingetLinks;$uvBin;$env:PATH"
$env:WHISPER__INFERENCE_DEVICE = 'cpu'
$env:WHISPER__COMPUTE_TYPE = 'int8'
$env:ENABLE_UI = 'false'
$env:LOG_LEVEL = 'info'

Write-Host "ffmpeg:  $((Get-Command ffmpeg).Source)"
Write-Host "repo:    $repoRoot"
Write-Host "Serving on http://127.0.0.1:8000 (Ctrl-C to stop)`n"

Set-Location $repoRoot
uv run uvicorn --factory --host 127.0.0.1 --port 8000 speaches.main:create_app
