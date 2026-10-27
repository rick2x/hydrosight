# PowerShell startup script for HydroSight AI
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Starting HydroSight AI (Local Development Servers)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $rootDir

Write-Host "[1/2] Starting FastAPI Backend on http://127.0.0.1:8000 ..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$rootDir'; python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload"

Write-Host "[2/2] Starting Vite Frontend on http://localhost:5173 ..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$rootDir\frontend'; npm run dev"

Start-Sleep -Seconds 3
Write-Host ""
Write-Host "HydroSight Web UI: http://localhost:5173" -ForegroundColor Green
Write-Host "FastAPI Swagger:  http://127.0.0.1:8000/docs" -ForegroundColor Green
Write-Host ""
