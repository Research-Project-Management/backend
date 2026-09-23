/**
 * project-history/index.ts
 * Public entrypoint for Manuscripts Project History module.
 */

export * from './project-history.module';
export * from './project-history.service';
export * from './project-history.controller';
export * from './dto/history.dto';

// Domain
export * from './core/domain/entities/snapshot.entity';
export * from './core/domain/entities/version-label.entity';
export * from './core/domain/value-objects/file-snapshot.vo';
export * from './core/domain/value-objects/file-diff.vo';
export * from './core/domain/value-objects/diff-hunk.vo';
export * from './core/domain/exceptions/version-not-found.exception';
export * from './core/domain/exceptions/duplicate-label.exception';
export * from './core/domain/exceptions/empty-project.exception';

// Ports
export * from './core/ports/history-repository.port';
export * from './core/ports/diff-engine.port';
export * from './core/ports/project-collector.port';
export * from './core/ports/project-restorer.port';

// Use cases
export * from './core/use-cases/create-snapshot.use-case';
export * from './core/use-cases/get-version-list.use-case';
export * from './core/use-cases/get-snapshot-by-version.use-case';
export * from './core/use-cases/compare-versions-diff.use-case';
export * from './core/use-cases/label-version.use-case';
export * from './core/use-cases/delete-label.use-case';
export * from './core/use-cases/restore-version.use-case';
