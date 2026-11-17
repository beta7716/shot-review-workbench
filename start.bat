@echo off
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
