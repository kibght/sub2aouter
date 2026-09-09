@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prerequisites.ps1"
if errorlevel 1 pause
