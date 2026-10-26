@echo off
title IN-SPACe CanSat Mission Control GCS
echo ============================================================
echo   IN-SPACe CanSat Ground Station v2.0
echo   Launching local server on http://localhost:8000
echo ============================================================
echo.
start http://localhost:8000
python -m http.server 8000
pause
