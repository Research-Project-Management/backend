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

// Subsystem 3: Compilation & CLSI
export * from './clsi/clsi.module';
export * from './clsi/clsi.controller';

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
export * from './history/history.controller';
export * from './history/services/snapshot.service';
export * from './history/services/diff.service';
export * from './history/services/label.service';
export * from './history/services/restore.service';
export * from './history/history.repository';
export * from './history/adapters/collector.adapter';
export * from './history/adapters/restorer.adapter';
export * from './history/dto/snapshot.dto';
export * from './history/dto/diff.dto';
export * from './history/dto/label.dto';
export * from './history/dto/restore.dto';
export * from './history/domain/diff';
export * from './history/domain/snapshot';
export * from './history/domain/snapshot';
export * from './history/domain/snapshot';
export * from './history/domain/label';
export * from './history/domain/errors';
export * from './history/domain/ports';

// Subsystem 5: Academic Authoring & Packaging
export { SpellingModule } from './spelling/spelling.module';
export { SpellingService } from './spelling/spelling.service';
export * from './spelling/dto/spelling.dto';
export { CitationsModule } from './citations/citations.module';
export { CitationsService } from './citations/services/citations.service';
export * from './citations/dto/citations.dto';
export * from './templates';
export * from './export-import/export-import.module';
export * from './export-import/services/export.service';
export * from './export-import/services/import.service';
export * from './export-import/services/convert.service';
export * from './export-import/services/scaffold.service';
export * from './export-import/dto/export.dto';
export * from './export-import/dto/import.dto';
export * from './export-import/dto/scaffold.dto';
export * from './git-bridge';
