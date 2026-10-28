@echo off
rem Double-click to start TubeFactory on Windows.
cd /d "%~dp0"
rem Install packages only when requirements.txt changed since the last start.
fc /b requirements.txt data\.requirements_installed >nul 2>&1 || (
  py -m pip install -q -r requirements.txt && (if not exist data mkdir data) && copy /y requirements.txt data\.requirements_installed >nul
)
py run.py
pause
