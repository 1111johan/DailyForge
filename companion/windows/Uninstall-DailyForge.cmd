@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\DailyForge\uninstall.ps1"
if errorlevel 1 pause
