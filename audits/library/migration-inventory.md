# Prisma Migration Inventory & Forensic Ledger Audit

**Feature ID**: `002-library-contract-data-cleanup`  
**Date**: `2026-08-31`  
**Audit Scope**: Database ledger in PostgreSQL `_prisma_migrations` vs local `backend/prisma/migrations/`

---

## 1. Migration Overview & State Comparison

`npx prisma migrate status` reports:
- **Local Migrations Found**: 1 (`20260831000000_init`)
- **Database Migrations Found**: 8
- **Last Common Migration**: `null`

---

## 2. Database Migration Ledger (`_prisma_migrations`)

Exact forensic query from PostgreSQL database `flux-db`:

| # | Migration Name | Migration ID | SHA-256 Checksum | Applied Steps | Started At | Finished At | Rolled Back |
| :- | :--- | :--- | :--- | :-: | :--- | :--- | :-: |
| 1 | `0_init` | `f5c02549-03e0-4d02-94ff-93cd9f4c8247` | `93dfab5546ea9b30686726a58c529a8ad0518a9283db84a65353f61f4d379fb5` | 0 | 2026-08-27 03:38:22Z | 2026-08-27 03:38:22Z | `null` |
| 2 | `20260827_sync_canonical_tables` | `e1c61af8-b7c2-4e19-9745-7a84a3f289e6` | `2fb23057706d53929a757f1e40034b5c9cdea9e00ac5d2ea511a812759110c80` | 0 | 2026-08-27 03:38:29Z | 2026-08-27 03:38:29Z | `null` |
| 3 | `20260827_zotero_integration_tables` | `33d24c08-12a8-4dc9-839f-aa045beb62d2` | `e73be9693af3f6546321153b489836701672f245d442e8f6683cbc665cc09264` | 0 | 2026-08-27 03:38:38Z | 2026-08-27 03:38:38Z | `null` |
| 4 | `20260827_integration_policies` | `f0043413-0ec1-43c3-9f2d-517ef454a393` | `c6cea7f9eef544a6e8b3da460bd03ccf62d48fc0674507112d4d56936139d99c` | 1 | 2026-08-27 06:39:41Z | 2026-08-27 06:39:42Z | `null` |
| 5 | `20260827_outbox_lease_and_dedupe` | `8bcafbe8-3dae-4b6c-a525-02b337795490` | `6beff34fadea422e913056e6362a2bc6694dfca2c8758ae9c4d75bd3b434fcc9` | 1 | 2026-08-27 07:10:28Z | 2026-08-27 07:10:29Z | `null` |
| 6 | `20260827_capture_previews` | `bb92784a-0c66-490d-997a-bedfc5a4baaf` | `e9f3500bc02dbe8d60567605044631d402ca124171eaaed5063986cbc0947de3` | 1 | 2026-08-27 07:51:10Z | 2026-08-27 07:51:10Z | `null` |
| 7 | `20260828_library_dedup_claims` | `31eaa0e2-0ba0-4434-a74a-ada05339a301` | `50aff9e3cb7e825afeb1b73a3cf755d51e4368b959d7de8de5c54b91281a63f7` | 1 | 2026-08-28 14:01:33Z | 2026-08-28 14:01:34Z | `null` |
| 8 | `20260828_attachment_extraction_lifecycle` | `adf527f6-c73c-49cf-ac41-926c1fa13c4e` | `12ad7154fd75408fdb7c5904be6e2c4f2b9686871cb91a2327df1faede0813d1` | 1 | 2026-08-28 14:53:26Z | 2026-08-28 14:53:26Z | `null` |

---

## 3. Forensic Investigation & Sources Searched

To recover the missing migration files, the following repositories and artifacts were deeply inspected:

1. **Git Commit History**:
   - `git log --all -- prisma/schema.prisma prisma/migrations`
   - `git log --all --full-history -- "prisma/migrations/*"`
   - Result: No commit in the repository history ever tracked the individual folders `0_init`, `20260827_sync_canonical_tables`, etc.
2. **Git Reflog**:
   - Inspected 50 previous HEAD entries (`git reflog -n 50`).
   - Inspected branches `master`, `origin/master`, `origin/feature/storage`.
   - Result: The migrations were generated and applied locally/in-memory or on a developer workstation and never committed to Git.
3. **Unreachable Objects & Dangling Blobs**:
   - `git fsck --unreachable` inspected all loose commits and blobs (e.g., commit `e43320a5`).
   - Result: No SQL migration files were found in unreachable blobs.
4. **Filesystem Search**:
   - Recursive search for all `*.sql` files across `d:\project\flux`.
   - Result: Only `backend/prisma/migrations/20260831000000_init/migration.sql` exists in the codebase.

### Recovery Status:
- **Recovered**: 0 / 8 historical migration SQL files in filesystem.
- **Unrecoverable in Git**: The 8 individual migration SQL scripts cannot be restored from Git history because they were never committed.
- **Intact in Database**: The physical schema in PostgreSQL `flux-db` is fully intact and currently contains all tables, columns, indexes, and constraints resulting from those 8 migrations.

---

## 4. Origin & Disposition of `20260831000000_init`

### Origin:
`backend/prisma/migrations/20260831000000_init/migration.sql` was created on 2026-08-31 as a consolidated ("squashed") schema migration capturing the complete target data model (including `papers`, `collections`, `zotero_connections`, `library_dedup_claims`, `attachment_extraction_lifecycle`, etc.).

### Decision & Disposition:
1. **DO NOT DELETE `20260831000000_init`**:
   - It is required as the baseline for initializing clean/new environments (e.g. CI/CD test runners, new developer environments).
2. **DO NOT ATTEMPT TO APPLY `20260831000000_init` TO THE EXISTING DATABASE**:
   - Applying it to `flux-db` will fail because `CREATE TABLE "users"`, `"papers"`, etc. already exist.
3. **DO NOT FAKE OR SYNTHESIZE MIGRATIONS**:
   - Creating mock SQL files to match the 8 names with artificial checksums would violate integrity and fail Prisma checksum verification.

---

## 5. Drift & Risk Analysis

| Environment Type | Current Database State | Local Migrations Directory | Risk | Proposed Handling Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **Existing Database** (`flux-db`) | Has tables for all 8 migrations; `_prisma_migrations` has 8 rows | Has `20260831000000_init` | `prisma migrate status` shows drift | **Treat existing schema as active baseline.** All new migrations starting in Phase 3 (`T013`, `T027`, `T031`) will be pure additive migrations (`202609...`). |
| **Clean / New Database** (CI / Test runner) | Empty database | Has `20260831000000_init` | None | `npx prisma migrate deploy` executes `20260831000000_init` cleanly on empty database. |

---

## 6. Prohibited Destructive Commands (Safety Boundary)

Under all circumstances during Phase 1–9 of this cleanup program, the following commands are **STRICTLY FORBIDDEN**:

- ❌ `npx prisma migrate reset` (Destroys database and erases live research data).
- ❌ `npx prisma db push` (Bypasses migration tracking and may cause silent schema drift).
- ❌ `npx prisma migrate resolve` (Dangerous manual override without verified checksums).
- ❌ Direct SQL `DROP TABLE`, `DROP COLUMN`, `TRUNCATE` (Violates expand-backfill-contract cycle).
- ❌ Manual deletion or modification of `_prisma_migrations` rows.
- ❌ Overwriting existing data with initial seeds.
