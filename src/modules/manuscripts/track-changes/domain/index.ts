/**
 * track-changes/domain/index.ts
 * Pure domain models, value objects, exceptions, ports, and line-patching logic for Track Changes.
 */

export * from './line-patcher';
export * from './track-change.entity';
export * from './comment-thread.entity';
export * from './comment-reply.entity';
export * from './text-range.vo';
export * from './change-not-found.exception';
export * from './thread-not-found.exception';
export * from './resolved-thread.exception';
export * from './track-changes.ports';
