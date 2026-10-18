/**
 * project-history/domain/index.ts
 * Pure domain logic, entities, value objects, exceptions, and ports for Project History.
 */

export * from './myers-diff.engine';
export * from './snapshot-normalizer';
export * from './snapshot.entity';
export * from './version-label.entity';
export * from './file-snapshot.vo';
export * from './file-diff.vo';
export * from './diff-hunk.vo';
export * from './version-not-found.exception';
export * from './duplicate-label.exception';
export * from './empty-project.exception';
export * from './history-repository.port';
export * from './diff-engine.port';
export * from './project-collector.port';
export * from './project-restorer.port';
