param([string]$Project, [int]$Port = 4318, [string]$DataRoot, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Project) { $env:VIDEO_PROJECT_ROOT = (Resolve-Path -LiteralPath $Project).Path }
if ($DataRoot) { $env:VIDEO_REVIEW_DATA_ROOT = [IO.Path]::GetFullPath($DataRoot) }
$env:PORT = [string]$Port
$projectPath = if ($env:VIDEO_PROJECT_ROOT) { [IO.Path]::GetFullPath($env:VIDEO_PROJECT_ROOT) } else { Join-Path $PSScriptRoot 'examples/demo' }
$dataPath = if ($env:VIDEO_REVIEW_DATA_ROOT) { $env:VIDEO_REVIEW_DATA_ROOT } else { Join-Path $PSScriptRoot 'data' }
$reviewUrl = "http://127.0.0.1:$Port/review.html"
$healthUrl = "http://127.0.0.1:$Port/api/health"
$health = $null
try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 } catch {}
if ($health -and ($health.service -ne 'shot-review-workbench' -or [IO.Path]::GetFullPath($health.projectRoot) -ne [IO.Path]::GetFullPath($projectPath) -or [IO.Path]::GetFullPath($health.dataRoot) -ne [IO.Path]::GetFullPath($dataPath))) { throw "Port $Port is serving another workbench/project. Use -Port with a different number." }
if (-not $health) {
    $node = (Get-Command node -ErrorAction Stop).Source
    New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
    $child = Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server.err.log')
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($child.HasExited) { break }
        try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1; if ($health.ok) { break } } catch {}
        Start-Sleep -Milliseconds 200
    }
}
if (-not $health.ok) { throw 'Video workbench did not start. Check data/server.err.log.' }
if (-not $NoBrowser) { Start-Process $reviewUrl }
Write-Output $reviewUrl
