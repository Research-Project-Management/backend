# Backend Agent Instructions

NestJS + Fastify + Prisma (PostgreSQL) backend. Keep changes small, typed, and verified.

## Repository layout

- `src/core/` — shared infrastructure (HTTP, logger, DB, cache, resilience)
- `src/modules/` — domain modules (`catalog`, `library`, `pages`, `chat`, `experiments`, `files`, `identity`, `project`, `ai`, `bff`, `realtime`, `activity`, `integrations`)
- `prisma/` — modular schema (`prisma/schema/`), migrations (`prisma/migrations/`), and `seed.ts`
- `scripts/ops/` — operational CLI scripts (must have a matching script in `package.json`)
- `test/` — `unit/` and `e2e/` test suites

## Non-negotiable rules

- **No new `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.**
- **No new `as unknown` or `any` casts** — narrow types or validate at I/O boundaries instead.
- **No empty `catch {}`** — handle the error, or name the variable and explain in a comment why ignoring is safe.
- **Keep `domain/` pure** — do not import `@prisma/client` or `@nestjs/*` inside `**/domain/**`.
- **No new `@Global()` modules** — declare explicit `imports` in NestJS modules.
- **Do not weaken or bypass quality gates** — never edit `lefthook.yml`, `.oxlintrc*.json`, `eslint.config.mjs`, `.github/workflows/**`, or `AGENTS.md` to silence a check; never use `--no-verify`.
- **Keep `scripts/` clean** — never leave temporary test/debug/benchmark files in the repo root or `scripts/`.

## Required verification before finishing

Run the fast verification gate on every change and fix all failures before reporting done:

```sh
pnpm run verify:quick
```

For cross-module refactors or before opening a PR, run the full check:

```sh
pnpm run verify:ci
```

Never run the full unit test suite by default during small edits; use `pnpm run test:changed` or the module-specific `pnpm run test:<module>` script.
