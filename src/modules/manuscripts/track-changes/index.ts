/**
 * track-changes/index.ts
 * Public entrypoint for Manuscripts Review Mode: Track Changes & Comments.
 */

export * from './track-changes.module';
export * from './track-changes.service';
export * from './track-changes.controller';
export * from './dto/track-changes.dto';

// Domain
export * from './core/domain/entities/track-change.entity';
export * from './core/domain/entities/comment-thread.entity';
export * from './core/domain/entities/comment-reply.entity';
export * from './core/domain/value-objects/text-range.vo';
export * from './core/domain/value-objects/change-metadata.vo';
export * from './core/domain/exceptions/change-not-found.exception';
export * from './core/domain/exceptions/thread-not-found.exception';
export * from './core/domain/exceptions/resolved-thread.exception';

// Ports
export * from './core/ports/track-changes-repository.port';
export * from './core/ports/docstore-patcher.port';
export * from './core/ports/realtime-notifier.port';

// Use Cases
export * from './core/use-cases/record-change.use-case';
export * from './core/use-cases/accept-change.use-case';
export * from './core/use-cases/reject-change.use-case';
export * from './core/use-cases/batch-resolve-changes.use-case';
export * from './core/use-cases/create-comment-thread.use-case';
export * from './core/use-cases/add-comment-reply.use-case';
export * from './core/use-cases/resolve-comment-thread.use-case';
export * from './core/use-cases/get-doc-reviews.use-case';
