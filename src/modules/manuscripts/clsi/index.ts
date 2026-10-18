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

// Domain (Pure in-process computation & contracts)
export * from './domain';

// DTOs
export * from './dto/clsi.dto';
export * from './dto/synctex.dto';
