/**
 * modules/manuscripts/clsi/index.ts
 * Public entrypoint and barrel export for the Manuscripts CLSI subsystem
 * (Common LaTeX Service Interface - LaTeX compilation & SyncTeX engine).
 */

// Module & Service
export * from './clsi.module';
export * from './clsi.service';
export * from './clsi.controller';

// DTOs
export * from './dto/clsi.dto';
export * from './dto/synctex.dto';

// Ports
export * from './core/ports/artifacts.port';
export * from './core/ports/engine.port';
export * from './core/ports/runner.port';
export * from './core/ports/workspace.port';

// Pipeline & Use Cases
export * from './core/pipeline/compile-pipeline';
export * from './core/pipeline/synctex.use-case';
export * from './core/pipeline/word-count.use-case';

// Adapters
export * from './core/adapters/engines/latexmk.engine';
export * from './core/adapters/engines/tectonic.engine';
export * from './core/adapters/runners/docker-sandbox.runner';
export * from './core/adapters/runners/local-process.runner';
export * from './core/adapters/workspace/incremental-workspace';
export * from './core/adapters/telemetry/clsi.metrics';
