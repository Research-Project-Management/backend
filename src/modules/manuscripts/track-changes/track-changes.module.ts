/**
 * track-changes/track-changes.module.ts
 * NestJS Module for Manuscripts Review Mode: Track Changes & Comments (Hexagonal Architecture).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { DocstoreModule } from '../docstore/docstore.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { TrackChangesController } from './track-changes.controller';
import { TrackChangesService } from './track-changes.service';

// Use Cases
import { RecordChangeUseCase } from './core/use-cases/record-change.use-case';
import { AcceptChangeUseCase } from './core/use-cases/accept-change.use-case';
import { RejectChangeUseCase } from './core/use-cases/reject-change.use-case';
import { BatchResolveChangesUseCase } from './core/use-cases/batch-resolve-changes.use-case';
import { CreateCommentThreadUseCase } from './core/use-cases/create-comment-thread.use-case';
import { AddCommentReplyUseCase } from './core/use-cases/add-comment-reply.use-case';
import { ResolveCommentThreadUseCase } from './core/use-cases/resolve-comment-thread.use-case';
import { GetDocReviewsUseCase } from './core/use-cases/get-doc-reviews.use-case';

// Ports
import { ITrackChangesRepositoryPort } from './core/ports/track-changes-repository.port';
import { IDocstorePatcherPort } from './core/ports/docstore-patcher.port';
import { IRealtimeNotifierPort } from './core/ports/realtime-notifier.port';

// Adapters
import { PrismaTrackChangesRepository } from './core/adapters/database/prisma-track-changes.repository';
import { DocstorePatcherAdapter } from './core/adapters/external/docstore-patcher.adapter';
import { RealtimeNotifierAdapter } from './core/adapters/external/realtime-notifier.adapter';

@Module({
  imports: [
    PrismaModule,
    DocstoreModule,
    RealtimeModule,
  ],
  controllers: [TrackChangesController],
  providers: [
    TrackChangesService,

    // Use Cases
    RecordChangeUseCase,
    AcceptChangeUseCase,
    RejectChangeUseCase,
    BatchResolveChangesUseCase,
    CreateCommentThreadUseCase,
    AddCommentReplyUseCase,
    ResolveCommentThreadUseCase,
    GetDocReviewsUseCase,

    // Driven Adapters
    PrismaTrackChangesRepository,
    DocstorePatcherAdapter,
    RealtimeNotifierAdapter,

    // Ports SPI Bindings
    {
      provide: ITrackChangesRepositoryPort,
      useClass: PrismaTrackChangesRepository,
    },
    {
      provide: IDocstorePatcherPort,
      useClass: DocstorePatcherAdapter,
    },
    {
      provide: IRealtimeNotifierPort,
      useClass: RealtimeNotifierAdapter,
    },
  ],
  exports: [
    TrackChangesService,
    ITrackChangesRepositoryPort,
    IDocstorePatcherPort,
    IRealtimeNotifierPort,
    RecordChangeUseCase,
    AcceptChangeUseCase,
    RejectChangeUseCase,
    BatchResolveChangesUseCase,
    CreateCommentThreadUseCase,
    AddCommentReplyUseCase,
    ResolveCommentThreadUseCase,
    GetDocReviewsUseCase,
  ],
})
export class TrackChangesModule {}
