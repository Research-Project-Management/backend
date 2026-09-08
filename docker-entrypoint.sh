#!/bin/sh
set -e

# ==============================================================================
# Flux Backend Production Container Entrypoint
# Standards: Multi-stage container, non-root, fail-safe database migration
# ==============================================================================

echo "========================================================"
echo " Starting Flux Backend Container (NestJS + Fastify)"
echo " NODE_ENV:    ${NODE_ENV:-production}"
echo " HOST:        ${HOST:-0.0.0.0}"
echo " PORT:        ${PORT:-3000}"
echo "========================================================"

# Graceful termination trap
trap 'echo "🛑 Container received termination signal. Exiting..."; exit 0' TERM INT

# Determine Prisma CLI runner path (prioritize local node script to eliminate package manager overhead)
PRISMA_CLI=""
if [ -f "./node_modules/prisma/build/index.js" ]; then
  PRISMA_CLI="node ./node_modules/prisma/build/index.js"
elif [ -f "./node_modules/.bin/prisma" ]; then
  PRISMA_CLI="./node_modules/.bin/prisma"
elif command -v pnpm >/dev/null 2>&1; then
  PRISMA_CLI="pnpm exec prisma"
else
  PRISMA_CLI="npx --no-install prisma"
fi

# Run database migrations if DATABASE_URL is configured
if [ -n "$DATABASE_URL" ] && [ "$SKIP_MIGRATIONS" != "true" ]; then
  echo "📦 [Database] Checking database connection and running Prisma migrations..."
  
  MAX_RETRIES=${DB_MAX_RETRIES:-20}
  RETRY_INTERVAL=${DB_RETRY_INTERVAL:-3}
  RETRY_COUNT=0
  MIGRATION_SUCCESS=0

  # Disable immediate exit on command error inside retry loop
  set +e
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    echo "🔄 [Database] Attempting migration deployment (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
    
    $PRISMA_CLI migrate deploy
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
      echo "✅ [Database] Prisma migrations applied successfully!"
      MIGRATION_SUCCESS=1
      break
    else
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        echo "⏳ [Database] Database not ready or locked. Retrying in ${RETRY_INTERVAL}s..."
        sleep "$RETRY_INTERVAL"
      fi
    fi
  done
  set -e

  if [ $MIGRATION_SUCCESS -eq 0 ]; then
    if [ "$IGNORE_MIGRATION_ERRORS" = "true" ]; then
      echo "⚠️ [Database] Migration failed after $MAX_RETRIES attempts, but IGNORE_MIGRATION_ERRORS=true. Continuing startup..."
    else
      echo "❌ [Database] FATAL: Prisma migrate deploy failed after $MAX_RETRIES attempts."
      echo "❌ [Database] Check your DATABASE_URL, network connectivity, and migration history."
      exit 1
    fi
  fi
else
  echo "⏩ [Database] Automatic migration skipped (SKIP_MIGRATIONS=${SKIP_MIGRATIONS:-false})."
fi

echo "🚀 [Server] Handing over execution to: $*"
exec "$@"
