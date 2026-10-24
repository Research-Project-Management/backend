/**
 * track-changes/track-changes.module.ts
 * NestJS Module for Manuscripts Review Mode: Track Changes & Comments.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';

import { TrackChangesController } from './track-changes.controller';
import { TrackChangesService } from './track-changes.service';
import { TrackChangesRepository } from './track-changes.repository';
import {
  DocstorePatcherAdapter,
  RealtimeNotifierAdapter,
} from './adapters/track-changes.adapters';
import {
  ITrackChangesRepositoryPort,
  IDocstorePatcherPort,
  IRealtimeNotifierPort,
} from './domain';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [TrackChangesController],
  providers: [
    TrackChangesService,
    TrackChangesRepository,
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,
    {
      provide: ITrackChangesRepositoryPort,
      useExisting: TrackChangesRepository,
    },
    {
      provide: IDocstorePatcherPort,
      useExisting: DocstorePatcherAdapter,
    },
    {
      provide: IRealtimeNotifierPort,
      useExisting: RealtimeNotifierAdapter,
    },
  ],
  exports: [
    TrackChangesService,
    TrackChangesRepository,
    ITrackChangesRepositoryPort,
    IDocstorePatcherPort,
    IRealtimeNotifierPort,
  ],
})
export class TrackChangesModule {}
