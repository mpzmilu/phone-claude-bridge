@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dingtalk-toggle.ps1" -Mode on
pause
