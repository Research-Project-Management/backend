/**
 * modules/manuscripts/clsi/index.ts
 * Public entrypoint and barrel export for the Manuscripts CLSI subsystem
 * (Common LaTeX Service Interface - LaTeX compilation & SyncTeX engine).
 */

// Module & Controller
export * from './clsi.module';
export * from './clsi.controller';

// Services
export * from './services/clsi.service';
export * from './services/workspace-planner.service';
export * from './services/compile-pipeline.service';
export * from './services/remote-clsi.client';

// Repositories
export * from './repositories/incremental-workspace.repository';

// Domain (Pure in-process computation)
export * from './domain';

// DTOs
export * from './dto/clsi.dto';
export * from './dto/synctex.dto';

// Ports & Real Seams
export * from './core/ports/artifacts.port';
export * from './core/ports/engine.port';
export * from './core/ports/runner.port';
export * from './core/ports/workspace.port';
export * from './core/adapters/engines/latexmk.engine';
export * from './core/adapters/engines/tectonic.engine';
export * from './core/adapters/runners/docker-sandbox.runner';
export * from './core/adapters/runners/local-process.runner';
export * from './core/adapters/telemetry/clsi.metrics';
export * from './core/pipeline/synctex.use-case';
export * from './core/pipeline/word-count.use-case';
