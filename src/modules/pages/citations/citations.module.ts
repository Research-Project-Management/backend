/**
 * citations/citations.module.ts
 * NestJS Module for Manuscripts Citations & Bibliography subsystem.
 */

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { PagesCoreModule } from '@/modules/pages/core';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';
import { LibraryModule } from '@/modules/library';

import { CitationsController } from './citations.controller';
import { CitationsService } from './services/citations.service';
import { CitationIndexService } from './services/citation-index.service';
import { CitationMetricsService } from './services/citation-metrics.service';
import {
  CITATION_SYNC_QUEUE,
  CitationSyncQueueService,
} from './services/citation-sync-queue.service';
import { IdentifierResolver } from './services/identifier-resolver.service';
import { ResilientIdentifierResolver } from './services/resilient-identifier-resolver.service';
import { LibrarySyncAdapter } from './services/library-sync.service';
import { CitationsRepository } from './repositories/citations.repository';
import { BibtexParser } from './domain/bibtex-parser.domain';
import { CitationSyncProcessor } from './processors/citation-sync.processor';
import { RedisCacheService } from '@/core';

const inProcessCitationWorkers =
  process.env.ENABLE_IN_PROCESS_WORKERS === 'true'
    ? [CitationSyncProcessor]
    : [];

@Module({
  imports: [
    PagesCoreModule,
    StructureModule,
    DocstoreModule,
    IntegrationsModule,
    LibraryModule,
    BullModule.registerQueue({
      name: CITATION_SYNC_QUEUE,
    }),
  ],
  controllers: [CitationsController],
  providers: [
    LibrarySyncAdapter,
    CitationMetricsService,
    CitationsRepository,
    CitationIndexService,
    CitationSyncQueueService,
    CitationsService,
    BibtexParser,
    IdentifierResolver,
    {
      provide: ResilientIdentifierResolver,
      useFactory: (
        resolver: IdentifierResolver,
        cache?: RedisCacheService,
      ) => new ResilientIdentifierResolver(resolver, cache),
      inject: [
        IdentifierResolver,
        { token: RedisCacheService, optional: true },
      ],
    },
    ...inProcessCitationWorkers,
  ],
  exports: [
    CitationsService,
    CitationsRepository,
    LibrarySyncAdapter,
    CitationMetricsService,
    CitationIndexService,
    CitationSyncQueueService,
    BibtexParser,
    IdentifierResolver,
    ResilientIdentifierResolver,
  ],
})
export class CitationsModule {}
