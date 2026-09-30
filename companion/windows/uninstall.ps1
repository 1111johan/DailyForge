$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:LOCALAPPDATA "DailyForge"
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "DailyForge"))
$resolvedRoot = [IO.Path]::GetFullPath($installRoot)
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "DailyForge Companion.lnk"
$bridgeRoot = Join-Path $env:USERPROFILE ".chrome-browser-control"

if ($resolvedRoot -ne $expectedRoot) {
  throw "卸载目录校验失败。"
}

$entryPath = Join-Path $installRoot "app\dailyforge-companion.mjs"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entryPath) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }

if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
}
if (Test-Path -LiteralPath $bridgeRoot) {
  $expectedBridgeRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".chrome-browser-control"))
  if ([IO.Path]::GetFullPath($bridgeRoot) -eq $expectedBridgeRoot) {
    Remove-Item -LiteralPath $bridgeRoot -Recurse -Force
  }
}

Set-Location $env:TEMP
if (Test-Path -LiteralPath $installRoot) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
  "DailyForge 已卸载，本机连接凭证和图片缓存已清除。请在 Chrome 扩展页移除 DailyForge 扩展。",
  "DailyForge 已卸载",
  "OK",
  "Information"
) | Out-Null
