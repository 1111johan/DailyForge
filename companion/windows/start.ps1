param(
  [switch]$OpenWizard
)

$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $appRoot "runtime\node\node.exe"
$entryPath = Join-Path $appRoot "dailyforge-companion.mjs"
$wizardUrl = "http://127.0.0.1:3108/"

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "DailyForge 运行组件不完整，请重新安装。"
}

$running = $false
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "$wizardUrl/api/status" -TimeoutSec 1
  $running = $response.StatusCode -eq 200
} catch {
  $running = $false
}

if (-not $running) {
  $startArguments = @{
    FilePath = $nodePath
    ArgumentList = @($entryPath, "serve")
    WorkingDirectory = $appRoot
    WindowStyle = "Hidden"
  }
  Start-Process @startArguments
}

if ($OpenWizard) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$wizardUrl/api/status" -TimeoutSec 1
      if ($response.StatusCode -eq 200) { break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  Start-Process $wizardUrl
}
