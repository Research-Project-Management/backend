/**
 * track-changes/track-changes.module.ts
 * NestJS Module for Manuscripts Review Mode: Track Changes & Comments (Adaptive Modular Monolith).
 */

import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { RealtimeModule } from '@/modules/realtime/realtime.module';

import { TrackChangesController } from './track-changes.controller';
import { TrackChangesService } from './track-changes.service';
import { TrackChangesRepository } from './track-changes.repository';

// Ports
import { ITrackChangesRepositoryPort } from './core/ports/track-changes-repository.port';
import { IDocstorePatcherPort } from './core/ports/docstore-patcher.port';
import { IRealtimeNotifierPort } from './core/ports/realtime-notifier.port';

// Adapters
import { DocstorePatcherAdapter } from './core/adapters/external/docstore-patcher.adapter';
import { RealtimeNotifierAdapter } from './core/adapters/external/realtime-notifier.adapter';

@Module({
  imports: [PrismaModule, forwardRef(() => DocstoreModule), RealtimeModule],
  controllers: [TrackChangesController],
  providers: [
    TrackChangesService,
    TrackChangesRepository,

    // Driven Adapters
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,

    // Ports SPI Bindings
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
