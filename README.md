# Flux Engine (Backend) — Engineering Handbook & Developer Guidelines

> **Internal Reference Manual** for backend developers, platform engineers, and AI agents contributing to the Flux Engine API, background workers, and real-time collaboration services.  
> Frontend Handbook: [`../frontend/README.md`](../frontend/README.md) | Product Vision: [`../PRODUCT.md`](../PRODUCT.md) | Interactive Swagger API Docs: [`http://localhost:3000/docs`](http://localhost:3000/docs)

---

## 📑 Table of Contents

1. [Technology Stack Matrix](#1-technology-stack-matrix)
2. [Local Environment & Sidecar Orchestration](#2-local-environment--sidecar-orchestration)
3. [Architecture & Directory Anatomy](#3-architecture--directory-anatomy)
4. [Domain Boundaries & Hybrid Modular Monolith](#4-domain-boundaries--hybrid-modular-monolith)
5. [Storage & Direct Presigned Upload Pipeline](#5-storage--direct-presigned-upload-pipeline)
6. [Database & Prisma 7 Connection Management](#6-database--prisma-7-connection-management)
7. [BullMQ Background Workers & Heavy Task Offloading](#7-bullmq-background-workers--heavy-task-offloading)
8. [Real-time Collaboration Engine (Socket.IO + Yjs CRDT)](#8-real-time-collaboration-engine-socketio--yjs-crdt)
9. [API Contract, Idempotency & Error Protocol](#9-api-contract-idempotency--error-protocol)
10. [Logging, Tracing & Observability](#10-logging-tracing--observability)
11. [Quality Gates, Git Hooks & PR Protocol](#11-quality-gates-git-hooks--pr-protocol)

---

## 1. Technology Stack Matrix

| Layer / Subsystem | Technology | Version | Rationale & Architectural Usage |
|---|---|---|---|
| **Runtime & HTTP Engine** | [NestJS](https://nestjs.com/) 11 + [Fastify](https://fastify.dev/) 5 | `@nestjs/core@11.x`, `@nestjs/platform-fastify@11.x` | High-throughput, non-blocking asynchronous event loop, 2.5x lower latency than Express |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | `5.7.x` | Strict typechecking, path aliases (`@/*`), strict null checks |
| **Database & ORM** | [PostgreSQL](https://www.postgresql.org/) 16 + [Prisma ORM](https://www.prisma.io/) 7 | `@prisma/client@7.x`, `@prisma/adapter-pg` | Type-safe declarative schema, driver adapter delegation to `pg.Pool`, connection isolation |
| **Cache & Real-time PubSub**| [Redis](https://redis.io/) 7-alpine | `ioredis@5.x`, `redis@4.x` | High-speed cache, distributed lock, Socket.IO adapter bus, and job state store |
| **Distributed Job Queues** | [BullMQ](https://docs.bullmq.io/) 6 | `@nestjs/bullmq@11.x`, `bullmq@6.x` | Heavy task offloading, exponential backoff, Dead Letter Queue (DLQ), sandboxed runners |
| **Real-time Collaboration** | [Socket.IO](https://socket.io/) 4 + [Yjs](https://yjs.dev/) | `@socket.io/redis-adapter@8.x`, `yjs@13.x` | Conflict-free Replicated Data Types (CRDT) for LaTeX & rich-text editing, multi-server scaling |
| **Object Storage** | [AWS S3 SDK v3](https://aws.amazon.com/sdk-for-javascript/) | `@aws-sdk/client-s3@3.x`, `@aws-sdk/s3-request-presigner` | Direct Presigned URL generation compatible with Cloudflare R2 and AWS S3 |
| **Compilation Sidecar** | [CLSI](https://github.com/overleaf/clsi) + [TeX Live](https://www.tug.org/texlive/) | Sidecar Container (Port 3013) | Isolated TeX Live (latexmk, pdflatex, xelatex, lualatex) engine for fast, reproducible PDF compilation |
| **Citation & Bibliometrics**| [Citation.js](https://citation.js.org/) | `@citation-js/core@0.7.x` | BibTeX, CSL-JSON, and RIS parsing, extraction, and formatting |
| **Documentation & Contract**| [Swagger / OpenAPI 3.0](https://swagger.io/) | `@fastify/swagger@9.x`, `@fastify/swagger-ui@6.x` | Automated interactive API specifications served at `/docs` |
| **Testing** | [Jest](https://jestjs.io/) 30 | `jest@30.x`, `ts-jest@29.x` | Feature-scoped test suites, db-suites integration, and smoke test suites |
| **Security & Hygiene** | [Helmet](https://github.com/fastify/fastify-helmet) + [Rate Limit](https://github.com/fastify/fastify-rate-limit) | Fastify Plugins | Strict HTTP security headers, per-IP rate limiting, brute-force protection |

---

## 2. Local Environment & Sidecar Orchestration

Flux backend relies on Docker Compose sidecar services for databases, caches, compilers, and dedicated workers.

### Prerequisites

- **Node.js**: `v20.x` or `v22.x` LTS
- **Package Manager**: `pnpm >= 10.27.0`
- **Docker & Docker Compose**: Docker Desktop running with Linux containers enabled

### Port Allocation Registry

| Service | Host Port | Internal Container Port | Description |
|---|---|---|---|
| **Flux Backend HTTP API** | `3000` (or `2916`) | `3000` | NestJS Fastify REST & WebSocket server |
| **PostgreSQL Database** | `5433` | `5432` | Mapped to 5433 to avoid collisions with local Postgres |
| **Redis Cache / Queue** | `6379` | `6379` | BullMQ queue store, cache, and Socket.IO Pub/Sub |
| **CLSI LaTeX Compiler** | `3013` | `3013` | Common LaTeX Service Interface microservice |
| **Flux Web Client (Frontend)**| `2915` | `2915` | Next.js Turbopack client (handled in `../frontend`) |

### Daily Development Commands

```bash
# 1. Start all infrastructure sidecars (PostgreSQL, Redis, Worker, CLSI)
pnpm run dev:infra

# 2. Generate Prisma Client (runs automatically on postinstall)
pnpm run prisma:generate

# 3. Start NestJS Fastify development server with hot-reload
pnpm run dev

# 4. In a separate terminal, start the dedicated background worker in watch mode
pnpm run dev:worker

# 5. If port 3000 or 2915 is locked by a lingering zombie process, run the cleanup tool:
pnpm run clean:ports
```

---

## 3. Architecture & Directory Anatomy

```
backend/
├── docker-compose.yml       # Production & local sidecar orchestration (db, redis, worker, clsi)
├── Dockerfile               # Multi-stage container build (deps, builder, runner)
├── prisma/
│   ├── schema.prisma        # Canonical database schema & models
│   ├── migrations/          # Version-controlled SQL migration history
│   └── seed.ts              # Idempotent database seeding script
├── src/
│   ├── main.ts              # Fastify HTTP server composition root & bootstrap
│   ├── app.module.ts        # Primary NestJS application module
│   ├── worker.ts            # Headless background worker bootstrap (non-HTTP)
│   ├── worker.module.ts     # Dedicated background worker composition root
│   ├── core/                # Shared foundational infrastructure
│   │   ├── adapters/        # RedisIoAdapter for Socket.IO horizontal clustering
│   │   ├── cache/           # Redis cache manager & key generators
│   │   ├── database/        # PrismaService & PrismaPg connection pool manager
│   │   ├── decorators/      # CurrentUser, Roles, Public, Idempotent decorators
│   │   ├── filters/         # GlobalExceptionFilter (RFC 7807 problem details)
│   │   ├── idempotency/     # IdempotencyInterceptor & Redis storage service
│   │   ├── interceptors/    # TransformInterceptor (envelope) & LoggerInterceptor
│   │   ├── logger/          # Structured JSON Pino logger service
│   │   └── utils/           # Rate-limiting rules & security helpers
│   ├── health/              # Liveness and readiness health checks (/health)
│   └── modules/             # 13 Domain Modules (Hybrid Modular Monolith)
│       ├── activity/        # Activity logs & project audit trail
│       ├── ai/              # Flux-AI proxy, streaming LLM chat, RAG search
│       ├── analytics/       # Workload velocity & project progress metrics
│       ├── identity/        # Auth, JWT refresh, OAuth2, RBAC guards
│       ├── integrations/    # External connectors (GitHub, Zotero, ORCID)
│       ├── library/         # Academic papers, CSL metadata, BibTeX parsing, ingestion
│       ├── manuscripts/     # LaTeX editor, document hierarchy, snapshots, CLSI client
│       ├── notifications/   # In-app notifications & email dispatching
│       ├── project/         # Projects, workspaces, memberships, and permissions
│       ├── realtime/        # Collaborative WebSocket gateways & Yjs CRDT rooms
│       ├── sticky/          # Infinite canvas sticky notes & spatial collaboration
│       ├── storage/         # Cloudflare R2 / S3 Presigned URLs & virtual file tree
│       └── work-item/       # Kanban items, sprints, cycles, and task relations
└── test/                    # Scoped test suites (unit, integration, smoke, benchmark)
```

---

## 4. Domain Boundaries & Hybrid Modular Monolith

Flux adopts a **Hybrid Feature-Modular Monolith** architecture:

```
[ HTTP Fastify Request ] ─────────────┐
                                       ▼
                     [ API Gateway / Interceptors ]
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         ▼                             ▼                             ▼
  [ Standard CRUD ]            [ Complex Domains ]          [ Infrastructure ]
  (Project, Identity,          (Storage, Manuscripts,       (Prisma, Redis,
   Work-Item, Sticky)           Library Ingestion, AI)       Logger, Sockets)
         │                             │                             │
         │ (Direct Service Call)       │ (Port / Adapter Boundary)   │
         ▼                             ▼                             ▼
  [ Service -> DB ]            [ External Drivers ]          [ Database / Cache ]
                               (S3, CLSI, OpenAI)
```

### Boundary Rules

1. **Standard CRUD Modules (80%)**: Follow standard NestJS modular patterns: `Controller -> Service -> PrismaService`. Keep boilerplate minimal.
2. **Heavy / External-facing Modules**: (`storage`, `manuscripts`, `library/ingestion`, `ai`) MUST use **Ports & Adapters** (interfaces for storage providers, LaTeX compilers, and AI vendors) to decouple core domain logic from 3rd-party vendor SDKs.
3. **Cross-Domain Communication**:
   - **Asynchronous Side-Effects**: ALWAYS use `EventEmitter2` (e.g. `this.eventEmitter.emit('paper.imported', payload)`). Never tightly couple unrelated domains.
   - **Synchronous Reads**: A module may inject another module's public `Service` (provided it is exported in its module declaration). Direct database access across module boundaries is strictly prohibited.
4. **Circular Dependencies**: Circular module imports (`forwardRef()`) are considered architectural smells. Refactor cross-domain couplings into domain events or extract shared logic into `core/`.

---

## 5. Storage & Direct Presigned Upload Pipeline

To maintain peak Fastify performance and protect server memory, **the backend strictly operates out-of-band for file uploads**.

### Direct Presigned Upload Protocol

```
Client (Browser)             Flux Backend API               Cloudflare R2 / S3          BullMQ Worker
      │                             │                              │                         │
      │ 1. POST /storage/presigned  │                              │                         │
      │    (fileName, size, mime)   │                              │                         │
      │────────────────────────────>│                              │                         │
      │                             │                              │                         │
      │ 2. Return Presigned PUT URL │                              │                         │
      │<────────────────────────────│                              │                         │
      │                             │                              │                         │
      │ 3. Direct HTTP PUT Binary Stream                           │                         │
      │───────────────────────────────────────────────────────────>│                         │
      │                             │                              │                         │
      │ 4. POST /storage/confirm    │                              │                         │
      │    (key, size, etag, mime)  │                              │                         │
      │────────────────────────────>│                              │                         │
      │                             │ 5. Verify & Create DB Record │                         │
      │                             │─────────────────────────────>│ (PostgreSQL)            │
      │                             │                              │                         │
      │                             │ 6. Enqueue Ingestion Job     │                         │
      │                             │───────────────────────────────────────────────────────>│
      │ 7. Return File Metadata     │                                                        │ 7. Process OCR,
      │<────────────────────────────│                                                        │    Extract Text
```

### Engineering Directives

- 🛑 **Strict Prohibition**: `file.toBuffer()` and in-memory multi-megabyte buffers are **strictly banned** anywhere in backend code.
- 📤 **File Size Threshold**: Any file payload larger than 10MB (PDFs, raw datasets, archives) **MUST** be uploaded directly via presigned URLs.
- ⚡ **Confirmation Endpoint**: Upon successful upload to the presigned URL, the client calls `POST /storage/confirm-upload`. The server validates the object exists, writes the database record, and dispatches an asynchronous BullMQ processing job.

---

## 6. Database & Prisma 7 Connection Management

Prisma ORM 7 runs via `@prisma/adapter-pg` using a pooled PostgreSQL connection driver.

### Bulkhead Pool Allocation Quotas

To prevent background queue processing from exhausting database connections needed for real-time web traffic, connection pools are strictly partitioned:

| Profile | Environment Variable | Default (Dev) | Default (Prod) | Rationale |
|---|---|---|---|---|
| **API Container (`be`)** | `DATABASE_POOL_MAX` | `25` | `35` | High concurrency for interactive HTTP requests and Socket.IO lookups |
| **Worker Container (`worker`)** | `DATABASE_POOL_MAX` | `10` | `15` | Isolated pool; background queue batches cannot starve the API |

- `idleTimeoutMillis`: `10,000ms` (Dev) / `30,000ms` (Prod)
- `connectionTimeoutMillis`: `20,000ms`

### Migration Governance

1. **Production Migrations**: Run strictly during CI/CD release stage or via explicit migration jobs (`pnpm prisma migrate deploy`).
2. **Worker Isolation**: The worker container sets `SKIP_MIGRATIONS=true` to prevent race conditions during cluster deployments.
3. **BigInt Serialization**: PostgreSQL `BIGINT` types are automatically serialized to string/number via global prototype override in `main.ts` and `prisma.service.ts`:
   ```typescript
   if (typeof BigInt.prototype.toJSON !== 'function') {
     BigInt.prototype.toJSON = function () {
       const num = Number(this);
       return Number.isSafeInteger(num) ? num : this.toString();
     };
   }
   ```

---

## 7. BullMQ Background Workers & Heavy Task Offloading

Heavy I/O, compilation, and CPU-intensive operations are strictly forbidden in HTTP request cycles and must be dispatched to BullMQ.

### Queue Partitioning & Concurrency Limits

| Queue Identifier | Concurrency | Task Type | Execution Strategy |
|---|---|---|---|
| `LIBRARY_INGESTION_QUEUE` | `4` | PDF text extraction, metadata parsing, citation indexing | Standard asynchronous processor |
| `LIBRARY_OUTBOX_QUEUE` | `5` | External database sync, webhook delivery | High-concurrency I/O bound |
| `STORAGE_PROCESSING_QUEUE` | `3` | Image thumbnails, asset conversions | Medium-concurrency worker |
| `MANUSCRIPT_CLSI_QUEUE` | `2` | LaTeX compilation via CLSI sidecar | Low-concurrency, CPU-heavy, sandboxed |

### Worker Resilience & DLQ Protocol

1. **Exponential Backoff with Jitter**:
   ```typescript
   defaultJobOptions: {
     attempts: 3,
     backoff: {
       type: 'exponential',
       delay: 2000, // 2s, 4s, 8s
     },
     removeOnComplete: 1000, // Clean completed metadata to protect Redis memory
     removeOnFail: 5000,     // Retain failed records for debugging
   }
   ```
2. **Dead Letter Queue (DLQ)**: When a job exhausts all retry attempts, it transitions to the failed set with full serialized error stack traces.
3. **Queue Health Dashboard**: Admins can inspect active, stalled, and failed jobs via Bull Board.

---

## 8. Real-time Collaboration Engine (Socket.IO + Yjs CRDT)

Collaborative document editing (LaTeX manuscripts, rich-text notes, sticky canvas) is powered by **Yjs CRDTs** over **Socket.IO** with Redis horizontal scaling.

```
Client A (Editor) ──WebSocket──┐
                               ▼
Client B (Editor) ──WebSocket──> [ NestJS Socket Gateway ] ──Pub/Sub──> [ Redis Adapter ]
                                          │                                   │
                               (Debounce 5s - 10s)                            │
                                          ▼                                   ▼
                              [ Materialized Snapshot ]           [ Peer Gateway Nodes ]
                               (Binary update + JSON)                         │
                                          ▼                                   ▼
                                 [ PostgreSQL DB ]                   Client C (Editor)
```

### Core Collaboration Rules

1. **Stateless Gateways**: Gateway instances maintain zero in-memory document state. Sockets join document-scoped rooms: `doc-room-${documentId}`.
2. **Materialized Snapshot Persistence**:
   - Real-time keystroke deltas flow exclusively in-memory via Redis Pub/Sub.
   - The server debounces writes (5s to 10s of inactivity, or immediately when the last user disconnects) to compile the Yjs document state into a binary update (`Y.encodeStateAsUpdate(ydoc)`) and persists it to PostgreSQL alongside a plain text snapshot.
3. **Client Reconnection & Catch-Up**:
   - When a client enters a room, the server serves the latest PostgreSQL base snapshot.
   - Any transient deltas remaining in Redis are replayed optimistically to the client.

---

## 9. API Contract, Idempotency & Error Protocol

All REST endpoints adhere strictly to unified envelopes and standard error structures.

### Standard Success Envelope (`TransformInterceptor`)

```json
{
  "success": true,
  "data": {
    "id": "doc_01j7xyz...",
    "title": "Quantum Error Mitigation in Superconducting Qubits"
  },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 142
  },
  "timestamp": "2026-10-11T14:30:00.000Z"
}
```

### Idempotency Contract

Mutating operations (`POST`, `PUT`, `DELETE`) that trigger side-effects (document exports, batch ingestion, payments) accept the `Idempotency-Key` or `X-Idempotency-Key` header:
- First execution stores the computed response in Redis for **24 hours**.
- Duplicate requests return the cached response with header: `Idempotent-Replay: true`.

### Standard Error Contract (RFC 7807 Problem Details)

Managed globally by `GlobalExceptionFilter`:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "validationErrors": [
    "title should not be empty",
    "doi must be a valid DOI string"
  ],
  "path": "/api/v1/library/papers",
  "timestamp": "2026-10-11T14:30:00.000Z"
}
```

> **Security Rule**: In production (`NODE_ENV === 'production'`), raw database query errors, Prisma internal codes, and stack traces are suppressed and logged internally.

---

## 10. Logging, Tracing & Observability

Logging uses structured JSON output powered by Pino and NestJS `LoggerService`.

### Distributed Correlation Tracing

- Every HTTP request receives or generates an `x-request-id` header (UUID v4).
- When an API endpoint publishes an event or queues a BullMQ job, `requestId` is injected into `job.data._requestId`.
- Socket.IO gateway events propagate `requestId` in client acknowledgment callbacks.
- Log entries include: `timestamp`, `level`, `context`, `requestId`, `method`, `url`, `durationMs`, and `statusCode`.

```json
{
  "level": "info",
  "time": 1791730200000,
  "context": "HTTP",
  "requestId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "method": "POST",
  "url": "/api/v1/storage/confirm-upload",
  "statusCode": 201,
  "durationMs": 42
}
```

---

## 11. Quality Gates, Git Hooks & PR Protocol

Flux adheres to a **rapid-velocity local development workflow** backed by strict type-hygiene and syntax safety.

### Git Pre-Commit Hook (Husky + lint-staged)

Every `git commit` triggers an automated pre-commit hook that verifies staged files:

```bash
# Executed automatically on git commit
npx lint-staged
```

1. **ESLint (`eslint --fix`)**: Verifies code hygiene and rules.
2. **Prettier (`prettier --write`)**: Formats code to strict repository conventions.
3. **Typecheck (`pnpm typecheck`)**: Compiles TypeScript with `--noEmit` across the entire project.

### Testing Policy (Developer Discretion)

Running full database test suites is **never blocking on local commits or pushes**. Developers run targeted scoped tests as needed for their features:

```bash
# Run unit tests for a specific domain module
pnpm test:library
pnpm test:manuscripts
pnpm test:storage
pnpm test:work-item
pnpm test:identity

# Fast smoke tests
pnpm test:smoke

# Full integration database suite (requires local Postgres sidecar)
pnpm test:db-suites
```

### Pull Request & Review Checklist

Before opening or merging a PR to `main`:

- [ ] Zero TypeScript errors: `pnpm typecheck` passes cleanly.
- [ ] Zero ESLint errors or unformatted files: `pnpm lint` passes cleanly.
- [ ] No `file.toBuffer()` or large multipart buffering introduced.
- [ ] Schema changes include clean Prisma migrations (`pnpm prisma migrate`).
- [ ] New REST endpoints documented with Swagger decorators (`@ApiOperation`, `@ApiResponse`).
- [ ] Connection pool sizes respect Bulkhead limits (`DATABASE_POOL_MAX`).
