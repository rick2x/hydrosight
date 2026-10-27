@echo off
echo ========================================================
echo   Starting HydroSight AI (Local Development Servers)
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/2] Starting FastAPI Backend on http://127.0.0.1:8000 ...
start "HydroSight Backend" cmd /k "python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload"

echo [2/2] Starting Vite Frontend on http://localhost:5173 ...
start "HydroSight Frontend" cmd /k "cd frontend && npm run dev"

timeout /t 3 /nobreak > nul
echo.
echo Both servers started!
echo HydroSight Web UI: http://localhost:5173
echo FastAPI Docs:     http://127.0.0.1:8000/docs
echo.
pause
