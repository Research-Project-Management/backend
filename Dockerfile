# Multi-stage Dockerfile for NestJS Fastify Backend
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# 1. Dependencies Stage
FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 2. Builder Stage
FROM base AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN pnpm run build
RUN pnpm prune --prod

# 3. Production Runner Stage
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Security: run as non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

COPY package.json ./
COPY prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Give ownership to nestjs user
USER nestjs

EXPOSE 3000

CMD ["node", "dist/main.js"]
