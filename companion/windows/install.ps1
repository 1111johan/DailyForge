$ErrorActionPreference = "Stop"

$packageRoot = $PSScriptRoot
$sourceApp = Join-Path $packageRoot "app"
$installRoot = Join-Path $env:LOCALAPPDATA "DailyForge"
$installApp = Join-Path $installRoot "app"
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "DailyForge Companion.lnk"

if (-not (Test-Path -LiteralPath $sourceApp -PathType Container)) {
  throw "安装包不完整：缺少 app 目录。"
}
if ([IO.Path]::GetFullPath($installRoot) -ne [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "DailyForge"))) {
  throw "安装目录校验失败。"
}

if (Test-Path -LiteralPath $installApp) {
  $entryPath = Join-Path $installApp "dailyforge-companion.mjs"
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entryPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $installApp -Recurse -Force
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath $sourceApp -Destination $installApp -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "uninstall.ps1") -Destination (Join-Path $installRoot "uninstall.ps1") -Force

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $installApp 'windows\start.ps1')`""
$shortcut.WorkingDirectory = $installApp
$shortcut.Description = "DailyForge 本机草稿助手"
$shortcut.Save()

& (Join-Path $installApp "windows\start.ps1") -OpenWizard
Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
  "DailyForge 已安装。接下来在打开的向导中输入管理员提供的一次性连接码。",
  "DailyForge 安装完成",
  "OK",
  "Information"
) | Out-Null
