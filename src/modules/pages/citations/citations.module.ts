/**
 * citations/citations.module.ts
 * NestJS Module for Pages Citations & Bibliography subsystem.
 */

import { Module } from '@nestjs/common';
import { PagesCoreModule } from '@/modules/pages/core';
import { DocstoreModule } from '@/modules/pages/docstore';
import { StructureModule } from '@/modules/pages/structure';
import { IntegrationsModule } from '@/modules/integrations';
import { LibraryModule } from '@/modules/library';

import { CitationsController } from './citations.controller';
import { CitationsService } from './services/citations.service';
import { CitationIndexService } from './services/index.service';
import { LibrarySyncAdapter } from './services/sync.service';
import { CitationsRepository } from './repositories/citations.repository';
import { BibtexParser } from './domain/bibtex.domain';

@Module({
  imports: [
    PagesCoreModule,
    StructureModule,
    DocstoreModule,
    IntegrationsModule,
    LibraryModule,
  ],
  controllers: [CitationsController],
  providers: [
    LibrarySyncAdapter,
    CitationsRepository,
    CitationIndexService,
    CitationsService,
    BibtexParser,
  ],
  exports: [CitationsService, CitationIndexService],
})
export class CitationsModule {}
