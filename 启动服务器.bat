@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Luxshare Volume Monitor

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install the LTS version from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

node serve.js

echo.
echo   Server stopped. Press any key to close.
pause >nul
