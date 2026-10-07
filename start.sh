#!/usr/bin/env bash

# ==============================================================================
# Flux Backend Environment Launcher (VPS Docker vs Local Dev)
# ==============================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# 1. If node and start-env.mjs are available, execute the Node.js orchestrator
if command -v node >/dev/null 2>&1 && [ -f "$DIR/scripts/start-env.mjs" ]; then
    exec node "$DIR/scripts/start-env.mjs" "$@"
fi

# 2. Native Bash execution (VPS without host node, or Linux dev environments)
IS_VPS=false

# Detect VPS / Production
if [ "$1" = "--prod" ] || [ "$1" = "--vps" ]; then
    IS_VPS=true
elif [ "$1" = "--dev" ] || [ "$1" = "--local" ]; then
    IS_VPS=false
elif [ -d "/opt/flux/backend" ] || [ "$NODE_ENV" = "production" ]; then
    IS_VPS=true
elif [ -f "$DIR/.env" ] && grep -E "^(NODE_ENV\s*=\s*production|COMPOSE_PROFILES\s*=.*prod)" "$DIR/.env" >/dev/null 2>&1; then
    IS_VPS=true
fi

if [ "$IS_VPS" = true ]; then
    echo ""
    echo "=============================================================="
    echo "🚀 [FLUX BACKEND - VPS PRODUCTION MODE]"
    echo "=============================================================="
    echo "Starting ALL services in Docker (DB, Redis, Backend, Worker, CLSI)..."
    echo ""

    docker compose --profile prod up -d

    echo ""
    echo "🔍 Container Status:"
    docker compose ps

    echo ""
    echo "✨ VPS Production stack is active in Docker."
    echo "   - Backend: Port 3000 (container flux_backend)"
    echo "   - Worker:  container flux_backend_worker"
    echo "=============================================================="
    echo ""
else
    echo ""
    echo "=============================================================="
    echo "💻 [FLUX BACKEND - LOCAL DEVELOPMENT MODE]"
    echo "=============================================================="
    echo "Stopping any conflicting Docker backend container (port 3000)..."
    docker stop flux_backend 2>/dev/null || true

    echo "Starting Docker services (db, redis, worker, clsi)..."
    docker compose up -d db redis worker clsi

    echo ""
    echo "🔍 Docker Services Status:"
    docker compose ps db redis worker clsi

    echo ""
    echo "=============================================================="
    echo "✨ Local Dev Environment Ready!"
    echo "   - PostgreSQL:     127.0.0.1:5433 (Docker)"
    echo "   - Redis:          127.0.0.1:6379 (Docker)"
    echo "   - CLSI Compiler:  127.0.0.1:3013 (Docker)"
    echo "   - BullMQ Worker:  flux_backend_worker (Docker)"
    echo "   - Backend Port:   Port 3000 is FREE for local dev"
    echo "--------------------------------------------------------------"
    echo "👉 To run your backend locally:"
    echo "   pnpm run dev"
    echo "=============================================================="
    echo ""
fi
