param(
  [string]$ChromeSkillPath = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedChromeSkillPath = if ($ChromeSkillPath) {
  [IO.Path]::GetFullPath($ChromeSkillPath)
} else {
  [IO.Path]::GetFullPath((Join-Path $repositoryRoot "companion\vendor\chrome-browser-control"))
}
$artifactRoot = if ($OutputDirectory) {
  [IO.Path]::GetFullPath($OutputDirectory)
} else {
  [IO.Path]::GetFullPath((Join-Path $repositoryRoot "artifacts\operator-package"))
}
$packageRoot = Join-Path $artifactRoot "DailyForge-Operator"
$appRoot = Join-Path $packageRoot "app"
$runtimeRoot = Join-Path $appRoot "runtime"

$expectedArtifactRoot = [IO.Path]::GetFullPath($artifactRoot)
$resolvedPackageRoot = [IO.Path]::GetFullPath($packageRoot)
if (-not $resolvedPackageRoot.StartsWith($expectedArtifactRoot + [IO.Path]::DirectorySeparatorChar)) {
  throw "输出目录校验失败。"
}
if (-not (Test-Path -LiteralPath $resolvedChromeSkillPath -PathType Container)) {
  throw "未找到 Chrome 控制组件：$resolvedChromeSkillPath"
}

if (Test-Path -LiteralPath $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\dailyforge-companion.mjs") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\wizard.html") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\windows") -Destination $appRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\windows\install.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\windows\uninstall.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\windows\Install-DailyForge.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot "companion\windows\Uninstall-DailyForge.cmd") -Destination $packageRoot
New-Item -ItemType Directory -Path (Join-Path $appRoot "vendor") -Force | Out-Null
$packagedSkillPath = Join-Path $appRoot "vendor\chrome-browser-control"
New-Item -ItemType Directory -Path $packagedSkillPath -Force | Out-Null
$skillCopyArgs = @(
  $resolvedChromeSkillPath,
  $packagedSkillPath,
  "/E",
  "/XD", "__pycache__",
  "/XF", "*.pyc",
  "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
)
& robocopy @skillCopyArgs | Out-Null
if ($LASTEXITCODE -gt 7) {
  throw "复制 Chrome 控制组件失败：$LASTEXITCODE"
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeRuntime = Join-Path $runtimeRoot "node"
New-Item -ItemType Directory -Path $nodeRuntime -Force | Out-Null
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $nodeRuntime "node.exe")

$pythonRoot = (python -c "import sys; print(sys.base_prefix)").Trim()
if (-not (Test-Path -LiteralPath (Join-Path $pythonRoot "python.exe"))) {
  throw "未找到可打包的 Python 运行环境。"
}
$pythonRuntime = Join-Path $runtimeRoot "python"
New-Item -ItemType Directory -Path $pythonRuntime -Force | Out-Null
foreach ($fileName in @(
  "python.exe",
  "pythonw.exe",
  "python3.dll",
  "python312.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "LICENSE.txt"
)) {
  $source = Join-Path $pythonRoot $fileName
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $pythonRuntime
  }
}
Copy-Item -LiteralPath (Join-Path $pythonRoot "DLLs") -Destination $pythonRuntime -Recurse
New-Item -ItemType Directory -Path (Join-Path $pythonRuntime "Lib") -Force | Out-Null
$robocopyArgs = @(
  (Join-Path $pythonRoot "Lib"),
  (Join-Path $pythonRuntime "Lib"),
  "/E",
  "/XD", "site-packages", "__pycache__",
  "/XF", "*.pyc",
  "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
)
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -gt 7) {
  throw "复制 Python 标准库失败：$LASTEXITCODE"
}

$zipPath = Join-Path $artifactRoot "DailyForge-Operator.zip"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal

$stream = [IO.File]::OpenRead($zipPath)
try {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha256.ComputeHash($stream)
  $hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
} finally {
  if ($sha256) { $sha256.Dispose() }
  $stream.Dispose()
}
[pscustomobject]@{
  Package = $zipPath
  Sha256 = $hash
  SizeMB = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
} | ConvertTo-Json
