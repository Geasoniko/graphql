@echo off
rem Like start.bat, but the app can also be opened from your phone (Tailscale or the same Wi-Fi).
rem Set the phone password in Settings first. Keep the laptop on and plugged in.
cd /d "%~dp0"
fc /b requirements.txt data\.requirements_installed >nul 2>&1 || (
  py -m pip install -q -r requirements.txt && (if not exist data mkdir data) && copy /y requirements.txt data\.requirements_installed >nul
)
py run.py --remote
pause
