/**
 * modules/pages/index.ts
 * Root entrypoint and barrel export for the Pages Subsystem
 * (Overleaf-parity modular architecture for LaTeX & Academic Publishing).
 */

export * from './pages.module';
export * from './pages.facade';
export * from './core';

// Subsystem 1: Virtual File System & Storage
export * from './filestore';
export * from './docstore';
export * from './structure';

// Subsystem 3: Compilation & Diagnostics
export * from './diagnostics';
export * from './clsi';

// Subsystem 4: Review & Versioning
export * from './review/review.module';
export * from './review/review.events';
export * from './review/review.repository';
export * from './review/services/comments.service';
export * from './review/services/suggestions.service';
export * from './review/services/status.service';
export * from './review/domain/change.domain';
export * from './review/domain/comment.domain';
export * from './review/domain/text-range.domain';
export * from './review/domain/patcher.domain';
export * from './review/domain/review.errors';
export * from './review/domain/review.policy';
export * from './review/domain/review.mapper';
export * from './history/history.module';
export * from './history/controllers/history.controller';
export * from './history/services/history.service';
export * from './history/repositories/history.repository';
export * from './history/adapters/snapshot-collector.adapter';
export * from './history/adapters/snapshot-restorer.adapter';
export * from './history/dto/history.dto';
export * from './history/domain/diff.domain';
export * from './history/domain/file-snapshot.domain';
export * from './history/domain/snapshot.domain';
export * from './history/domain/snapshot.mapper';
export * from './history/domain/version-label.domain';
export * from './history/domain/history.errors';
export * from './history/domain/history.ports';

// Subsystem 5: Academic Authoring & Packaging
export * from './spelling';
export * from './citations';
export * from './templates';
export * from './export-import';
export * from './git-bridge';
