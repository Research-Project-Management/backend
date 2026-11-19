/**
 * track-changes/index.ts
 * Public entrypoint for Manuscripts Review Mode: Track Changes & Comments.
 */

export * from './track-changes.module';
export * from './track-changes.service';
export * from './track-changes.controller';
export * from './track-changes.repository';
export * from './controllers/review-comments.controller';
export * from './controllers/review-suggestions.controller';
export * from './controllers/review-status.controller';
export * from './services/review-comments.service';
export * from './services/review-suggestions.service';
export * from './services/review-notification.dispatcher';
export * from './repositories/review-scope.repository';
export * from './dto/review-status.dto';
export * from './adapters/track-changes.adapters';
export * from './dto/track-changes.dto';
export * from './domain';
