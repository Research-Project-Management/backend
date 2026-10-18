# Tasks: LaTeX Compile Sandbox Isolation

**Feature**: `004-compile-sandbox-isolation`
**Branch**: `004-compile-sandbox-isolation`
**Spec Artifacts**: `specs/004-compile-sandbox-isolation/{spec.md, plan.md, research.md, quickstart.md, contracts/sandbox-runner.md}`

---

## Phase 1: Setup & Structural Refactoring (Slice S0)

**Goal**: Extract runners and watchdog out of `compile-pipeline.service.ts` into `services/sandbox/` without behavior change, keeping file sizes compliant (Constitution I).

- [x] T001 [P] Create `ProcessWatchdog` in `backend/src/modules/manuscripts/clsi/services/sandbox/process-watchdog.ts`
- [x] T002 [P] Create `LocalProcessRunner` in `backend/src/modules/manuscripts/clsi/services/sandbox/local-process.runner.ts`
- [x] T003 [P] Create `DockerSandboxRunner` in `backend/src/modules/manuscripts/clsi/services/sandbox/docker-sandbox.runner.ts`
- [x] T004 Refactor `compile-pipeline.service.ts` to re-export/import runners and verify existing tests pass

**Checkpoint**: Slice S0 complete. Runners cleanly separated; no regressions.

---

## Phase 2: Foundational Domain Primitives (Slice S1/S2/S4 Foundation)

**Goal**: Define typed errors, `SandboxProfile`, and ports extensions.

- [x] T005 [P] Create typed domain errors (`SandboxUnavailableException`, `SandboxConfigurationException`, `SandboxPolicyViolationException`, `UnsafePathException`) in `backend/src/modules/manuscripts/clsi/domain/sandbox-errors.ts`
- [x] T006 [P] Create `SandboxProfile` type and defaults in `backend/src/modules/manuscripts/clsi/domain/sandbox-profile.ts`
- [x] T007 Extend `ISandboxRunner` and `ProcessExecutionOptions` with `profile`, `runId`, `env` in `backend/src/modules/manuscripts/clsi/domain/clsi-ports.ts`

**Checkpoint**: Foundational types ready for test-driven implementation.

---

## Phase 3: User Story 1 - Shell-Escape Closed & Advisory Diagnostics (Slice S1, Priority: P1)

**Goal**: Shell-escape can NEVER be enabled from project content; `requiresShellEscape` removed; engines pass explicit `-no-shell-escape`; detect constructs for advisory diagnostic.

### Tests for User Story 1
- [x] T008 [P] [US1] Unit test for shell-escape advisory detection in `backend/test/unit/manuscripts/clsi/shell-escape-policy.spec.ts`
- [x] T009 [P] [US1] Unit test asserting engine invocation arguments never contain `-shell-escape` or `-Z shell-escape` in `backend/test/unit/manuscripts/clsi/compile-tex-flags.spec.ts`

### Implementation for User Story 1
- [x] T010 [US1] Refactor `DraftModeManager.requiresShellEscape` to advisory-only `detectShellEscapeUsage` in `backend/src/modules/manuscripts/clsi/domain/draft-mode.manager.ts`
- [x] T011 [US1] Update `TexEngineDetector` to remove shell-escape enabling flag and return advisory list in `backend/src/modules/manuscripts/clsi/domain/tex-engine.detector.ts`
- [x] T012 [US1] Refactor `CompilePipelineService`: enforce `-no-shell-escape` (latexmk), no `-Z shell-escape` (tectonic), and attach `shellEscapeAdvisories` to diagnostics
- [x] T013 [US1] Run unit tests T008 and T009 to verify shell-escape closed

**Checkpoint**: Remote Code Execution (RCE) path closed.

---

## Phase 4: User Story 3 - Environment Allow-List & TeX I/O Hardening (Slice S2, Priority: P1)

**Goal**: Compile processes receive strictly allow-listed environment variables (no `JWT_SECRET`, no `DATABASE_URL`); inject `openin_any=p`, `openout_any=p`, `shell_escape=f`.

### Tests for User Story 3
- [x] T014 [P] [US3] Unit test for environment allow-list and TeX parameter injection in `backend/test/unit/manuscripts/clsi/sandbox-env.builder.spec.ts`

### Implementation for User Story 3
- [x] T015 [US3] Implement pure `buildSandboxEnv` allow-list function in `backend/src/modules/manuscripts/clsi/domain/sandbox-env.builder.ts`
- [x] T016 [US3] Integrate `buildSandboxEnv` into `LocalProcessRunner` in `backend/src/modules/manuscripts/clsi/services/sandbox/local-process.runner.ts`
- [x] T017 [US3] Integrate `buildSandboxEnv` into `DockerSandboxRunner` in `backend/src/modules/manuscripts/clsi/services/sandbox/docker-sandbox.runner.ts`
- [x] T018 [US3] Run T014 and verify environment isolation

**Checkpoint**: Compile processes isolated from server secrets and external files.

---

## Phase 5: User Story 2 & 5 - Fail-Closed Configuration Policy & Dev Mode (Slice S4, Priority: P1/P3)

**Goal**: Enforce `ClsiSandboxConfig` bootstrap validation; fail closed in production without container or with unpinned image; allow `local-unsafe` only in development/test with warning.

### Tests for User Story 2 & 5
- [x] T019 [P] [US2/US5] Unit test for sandbox config bootstrap validation and fail-closed rules in `backend/test/unit/manuscripts/clsi/sandbox-config.spec.ts`

### Implementation for User Story 2 & 5
- [x] T020 [US2/US5] Implement `ClsiSandboxConfig` and bootstrap validation in `backend/src/modules/manuscripts/clsi/services/sandbox/sandbox-config.ts`
- [x] T021 [US2/US5] Wire `ClsiSandboxConfig` in `backend/src/modules/manuscripts/clsi/clsi.module.ts`
- [x] T022 [US5] Add one-time warning log to `LocalProcessRunner` when running in `local-unsafe` mode
- [x] T023 [US2] Update CLSI health check in `CompilePipelineService` to report unavailable when sandbox is offline
- [x] T024 [US2/US5] Run T019 and verify fail-closed configuration validation

**Checkpoint**: Production compile refuses to run without locked container.

---

## Phase 6: User Story 2 - Hardened Docker Container Runner & Lifecycle (Slice S3, Priority: P1)

**Goal**: Non-root `--user`, `--read-only`, size-limited `--tmpfs`, `--network none`, `--cap-drop ALL`, ulimits, `--memory-swap`, named container lifecycle killing container on abort/timeout.

### Tests for User Story 2
- [x] T025 [P] [US2] Unit test for `DockerSandboxRunner` argument generation and abort/timeout lifecycle in `backend/test/unit/manuscripts/clsi/docker-sandbox.runner.spec.ts`

### Implementation for User Story 2
- [x] T026 [US2] Implement hardened Docker CLI arguments builder in `backend/src/modules/manuscripts/clsi/services/sandbox/docker-sandbox.runner.ts`
- [x] T027 [US2] Implement named container lifecycle (`flux-clsi-<runId>`) with reliable `docker kill`/`rm -f` on abort/timeout
- [x] T028 [US2] Bind container limits (memory, cpus, pids, fsize, nofile, tmpfs) from `SandboxProfile`
- [x] T029 [US2] Run T025 and verify Docker container hardening arguments and lifecycle cleanup

**Checkpoint**: Container sandbox fully locked down and lifecycle contained.

---

## Phase 7: User Story 4 - SafePath Traversal & Prefix Collision Hardening (Slice S5, Priority: P2)

**Goal**: Harden `SafePath` against prefix collision (`/scratch/abc` vs `/scratch/abcd`), trailing `..` segments, null bytes, and symlinks pointing outside workspace.

### Tests for User Story 4
- [x] T030 [P] [US4] Unit test for SafePath prefix collision, traversal, and symlink rejection in `backend/test/unit/manuscripts/clsi/safe-path.spec.ts`

### Implementation for User Story 4
- [x] T031 [US4] Harden `sanitizeRelativePath` and `assertSafePath` in `backend/src/modules/manuscripts/clsi/domain/safe-path.ts`
- [x] T032 [US4] Add async `assertSafeSymlinkFreePath` using `fs.realpath` in `safe-path.ts`
- [x] T033 [US4] Update `IncrementalWorkspaceRepository` to use hardened `SafePath` methods in `backend/src/modules/manuscripts/clsi/repositories/incremental-workspace.repository.ts`
- [x] T034 [US4] Run T030 and verify SafePath hardening

**Checkpoint**: Workspace path traversal and prefix collision latent vectors eliminated.

---

## Phase 8: Polish & Cross-Cutting Verification (Slice S6)

**Goal**: Full verification, zero TypeScript errors, clean linter, all manuscript tests passing.

- [x] T035 [P] Run typecheck across backend (`pnpm typecheck`)
- [x] T036 [P] Run linter across modified files (`pnpm eslint "src/modules/manuscripts/clsi/**/*.ts"`)
- [x] T037 Run all CLSI unit tests (`pnpm test test/unit/manuscripts/clsi/`)
- [x] T038 Run full manuscript test suites (`pnpm test:manuscripts`)
- [x] T039 Update roadmap artifact `speckit-roadmap.md` and mark 004 complete

---
