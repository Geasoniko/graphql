@echo off
rem Double-click to start TubeFactory on Windows.
cd /d "%~dp0"
py -m pip install -q -r requirements.txt
py run.py
pause
