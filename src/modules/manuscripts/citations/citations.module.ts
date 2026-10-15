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

// Controllers, Service & Repository
import {
  CitationsController,
  CitationsUtilityController,
} from './citations.controller';
import { CitationsService } from './citations.service';
import { CitationsRepository } from './citations.repository';

// Ports & Adapters
import { BIBTEX_PARSER_PORT } from './core/ports/bibtex-parser.port';
import { IDENTIFIER_RESOLVER_PORT } from './core/ports/identifier-resolver.port';
import { CITATIONS_AGGREGATOR_PORT } from './core/ports/citations-aggregator.port';
import { LIBRARY_SYNC_PORT } from './core/ports/library-sync.port';
import { RegexAstBibtexParser } from './core/adapters/parser/regex-ast-bibtex.parser';
import { CrossrefArxivResolverAdapter } from './core/adapters/resolver/crossref-arxiv.resolver';
import { ManuscriptBibAggregatorAdapter } from './core/adapters/external/manuscript-bib-aggregator.adapter';
import { PluggableLibrarySyncAdapter } from './core/adapters/library/pluggable-library-sync.adapter';

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

    // External client bridges & driven adapters
    RegexAstBibtexParser,
    CrossrefArxivResolverAdapter,
    ManuscriptBibAggregatorAdapter,
    PluggableLibrarySyncAdapter,
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
