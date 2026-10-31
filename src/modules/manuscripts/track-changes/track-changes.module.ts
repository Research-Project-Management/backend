/**
 * track-changes/track-changes.module.ts
 * NestJS Module for Manuscripts Review Mode: Track Changes & Comments.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { PagesReviewController } from '@/modules/manuscripts/docstore/controllers/review.controller';

import { TrackChangesController } from './track-changes.controller';
import { TrackChangesService } from './track-changes.service';
import { TrackChangesRepository } from './track-changes.repository';
import {
  DocstorePatcherAdapter,
  RealtimeNotifierAdapter,
} from './adapters/track-changes.adapters';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [TrackChangesController, PagesReviewController],
  providers: [
    TrackChangesService,
    TrackChangesRepository,
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,
  ],
  exports: [
    TrackChangesService,
    TrackChangesRepository,
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,
  ],
})
export class TrackChangesModule {}
