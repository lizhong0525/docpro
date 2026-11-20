@echo off
setlocal
chcp 65001 >nul
title DocPro
if not exist "%~dp0runtime\node.exe" (
  echo Missing runtime\node.exe. Please extract the complete ZIP first.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0tools\launch.mjs" %*
if errorlevel 1 (
  if not "%~1"=="--no-browser" pause
  exit /b 1
)
