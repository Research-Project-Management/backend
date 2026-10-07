# ==============================================================================
# Flux Backend Environment Launcher for Windows PowerShell
# ==============================================================================

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# If node is installed, run start-env.mjs
if (Get-Command node -ErrorAction SilentlyContinue) {
    node "$ScriptDir\scripts\start-env.mjs" $args
    exit $LASTEXITCODE
}

# Fallback PowerShell execution
Write-Host "`n==============================================================" -ForegroundColor Cyan
Write-Host "💻 Starting Flux Backend in Local Dev Mode (Docker Infra Only)" -ForegroundColor Cyan
Write-Host "==============================================================`n" -ForegroundColor Cyan

# Stop any running backend container on Docker (port 3000)
$running = docker ps --format "{{.Names}}" 2>$null
if ($running -match "flux_backend") {
    Write-Host "Stopping Docker flux_backend to free port 3000..." -ForegroundColor Yellow
    docker stop flux_backend 2>$null | Out-Null
}

# Start infra services, worker and clsi in Docker
docker compose up -d db redis worker clsi
docker compose ps db redis worker clsi

# Start CLSI compiler container if present
$allContainers = docker ps -a --format "{{.Names}}" 2>$null
if ($allContainers -match "flux_clsi") {
    $runningComp = docker ps --format "{{.Names}}" 2>$null
    if ($runningComp -notmatch "flux_clsi") {
        Write-Host "Starting flux_clsi..." -ForegroundColor Yellow
        docker start flux_clsi 2>$null | Out-Null
    }
}

Write-Host "`n==============================================================" -ForegroundColor Green
Write-Host "✨ Local Dev Environment Ready!" -ForegroundColor Green
Write-Host "   - PostgreSQL:     127.0.0.1:5433 (Docker)" -ForegroundColor Green
Write-Host "   - Redis:          127.0.0.1:6379 (Docker)" -ForegroundColor Green
Write-Host "   - CLSI Compiler:  127.0.0.1:3013 (Docker)" -ForegroundColor Green
Write-Host "   - BullMQ Worker:  flux_backend_worker (Docker)" -ForegroundColor Green
Write-Host "   - Backend Port:   Port 3000 is FREE for local dev" -ForegroundColor Green
Write-Host "--------------------------------------------------------------"
Write-Host "👉 To start your backend locally, run:" -ForegroundColor Yellow
Write-Host "   pnpm run dev`n" -ForegroundColor White
