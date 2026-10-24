/**
 * track-changes/domain/index.ts
 * Pure domain models, value objects, exceptions, ports, and line-patching logic for Track Changes.
 */

export * from './line-patcher';
export * from './track-change.entity';
export * from './comment-thread.entity';
export * from './comment-reply.entity';
export * from './text-range.vo';
export * from './track-changes.exceptions';
export * from './track-changes.ports';