/**
 * project-history/domain/index.ts
 * Pure domain logic, entities, value objects, and exceptions for Project History.
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
