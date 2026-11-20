/**
 * track-changes/track-changes.module.ts
 * NestJS Module for Manuscripts Review Mode: Track Changes & Comments.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';

import { TrackChangesController } from './track-changes.controller';
import { ReviewCommentsController } from './controllers/review-comments.controller';
import { ReviewSuggestionsController } from './controllers/review-suggestions.controller';
import { ReviewStatusController } from './controllers/review-status.controller';
import { TrackChangesService } from './track-changes.service';
import { TrackChangesRepository } from './track-changes.repository';
import { ReviewScopeRepository } from './repositories/review-scope.repository';
import { ReviewCommentsService } from './services/review-comments.service';
import { ReviewSuggestionsService } from './services/review-suggestions.service';
import {
  DocstorePatcherAdapter,
  RealtimeNotifierAdapter,
} from './adapters/track-changes.adapters';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [
    TrackChangesController,
    ReviewCommentsController,
    ReviewSuggestionsController,
    ReviewStatusController,
  ],
  providers: [
    TrackChangesService,
    TrackChangesRepository,
    ReviewScopeRepository,
    ReviewCommentsService,
    ReviewSuggestionsService,
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,
  ],
  exports: [
    TrackChangesService,
    TrackChangesRepository,
    ReviewScopeRepository,
    ReviewCommentsService,
    ReviewSuggestionsService,
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,
  ],
})
export class TrackChangesModule {}
