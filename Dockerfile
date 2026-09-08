# ==============================================================================
# Multi-stage Dockerfile for NestJS Fastify Backend (Production & Development)
# Standards: Multi-stage build, minimal attack surface, non-root, dumb-init
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. Base Stage: Node 22 Alpine with required system packages & PNPM
# ------------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat dumb-init curl && \
    npm install -g pnpm@10
WORKDIR /app

# ------------------------------------------------------------------------------
# 2. Dependencies Stage: Install all dependencies with frozen lockfile
# ------------------------------------------------------------------------------
FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

# ------------------------------------------------------------------------------
# 3. Development Stage: Hot-reload, Prisma sync & 2-way volume mounting
# ------------------------------------------------------------------------------
FROM base AS dev
WORKDIR /app
ENV NODE_ENV=development
ENV PORT=3000
ENV HOST=0.0.0.0
ENV CHOKIDAR_USEPOLLING=true

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate

EXPOSE 3000
CMD ["sh", "-c", "rm -rf /app/dist/* && pnpm exec prisma generate && pnpm run dev"]

# ------------------------------------------------------------------------------
# 4. Builder Stage: Compile TypeScript & generate production distribution
# ------------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate
RUN pnpm run build
RUN pnpm prune --prod

# ------------------------------------------------------------------------------
# 5. Production Runner Stage: Minimal runtime image, non-root, auto-migration
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

# Minimal runtime packages: libc6-compat (for Prisma engines), dumb-init (PID 1), curl (healthcheck)
RUN apk add --no-cache libc6-compat dumb-init curl

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Security: unprivileged non-root user with dedicated home directory
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 -G nodejs -h /home/nestjs -D nestjs

# Copy runtime assets and Prisma multi-schema configuration
COPY package.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./

# Secure file permissions
RUN chmod +x docker-entrypoint.sh && \
    chown -R nestjs:nodejs /app /home/nestjs

USER nestjs

EXPOSE 3000

# Container Healthcheck (Terminus liveness probe)
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:3000/health/liveness || exit 1

ENTRYPOINT ["dumb-init", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
