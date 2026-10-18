/**
 * citations/citations.module.ts
 * NestJS Module for Manuscripts Citations & Bibliography subsystem.
 */

import { forwardRef, Module } from '@nestjs/common';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { PrismaModule } from '@/core';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';
import { LibraryModule } from '@/modules/library';

import {
  CitationsController,
  CitationsUtilityController,
} from './citations.controller';
import { CitationsService } from './citations.service';
import { CitationsRepository } from './citations.repository';
import {
  BIBTEX_PARSER_PORT,
  IDENTIFIER_RESOLVER_PORT,
  CITATIONS_AGGREGATOR_PORT,
  LIBRARY_SYNC_PORT,
  RegexAstBibtexParser,
  CrossrefArxivResolverAdapter,
} from './domain';

@Module({
  imports: [
    StructureModule,
    DocstoreModule,
    PrismaModule,
    forwardRef(() => IntegrationsModule),
    forwardRef(() => LibraryModule),
  ],
  controllers: [CitationsController, CitationsUtilityController],
  providers: [
    CitationsRepository,
    CitationsService,
    RegexAstBibtexParser,
    CrossrefArxivResolverAdapter,
    {
      provide: BIBTEX_PARSER_PORT,
      useExisting: CitationsRepository,
    },
    {
      provide: IDENTIFIER_RESOLVER_PORT,
      useExisting: CitationsRepository,
    },
    {
      provide: CITATIONS_AGGREGATOR_PORT,
      useExisting: CitationsRepository,
    },
    {
      provide: LIBRARY_SYNC_PORT,
      useExisting: CitationsRepository,
    },
  ],
  exports: [
    CitationsService,
    CitationsRepository,
    BIBTEX_PARSER_PORT,
    IDENTIFIER_RESOLVER_PORT,
    CITATIONS_AGGREGATOR_PORT,
    LIBRARY_SYNC_PORT,
  ],
})
export class CitationsModule {}
