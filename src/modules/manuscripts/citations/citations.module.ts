/**
 * citations/citations.module.ts
 * NestJS Module configuring Ports, Adapters, Use Cases, Controller & Service
 * for Manuscripts Citations & Bibliography subsystem.
 */

import { Module } from '@nestjs/common';
import { StructureModule } from '../structure/structure.module';
import { DocstoreModule } from '../docstore/docstore.module';

// Controllers & Service
import { CitationsController, CitationsUtilityController } from './citations.controller';
import { CitationsService } from './citations.service';

// Ports
import { BIBTEX_PARSER_PORT, IBibtexParserPort } from './core/ports/bibtex-parser.port';
import { IDENTIFIER_RESOLVER_PORT, IIdentifierResolverPort } from './core/ports/identifier-resolver.port';
import { CITATIONS_AGGREGATOR_PORT, ICitationsAggregatorPort } from './core/ports/citations-aggregator.port';
import { LIBRARY_SYNC_PORT, ILibrarySyncPort } from './core/ports/library-sync.port';

// Adapters
import { RegexAstBibtexParser } from './core/adapters/parser/regex-ast-bibtex.parser';
import { CrossrefArxivResolverAdapter } from './core/adapters/resolver/crossref-arxiv.resolver';
import { ManuscriptBibAggregatorAdapter } from './core/adapters/external/manuscript-bib-aggregator.adapter';
import { PluggableLibrarySyncAdapter } from './core/adapters/library/pluggable-library-sync.adapter';

// Use Cases
import { SearchCitationKeysUseCase } from './core/use-cases/search-citation-keys.use-case';
import { ResolveIdentifierToBibUseCase } from './core/use-cases/resolve-identifier-to-bib.use-case';
import { ValidateProjectBibtexUseCase } from './core/use-cases/validate-project-bibtex.use-case';
import { SyncLibraryCollectionUseCase } from './core/use-cases/sync-library-collection.use-case';

@Module({
  imports: [StructureModule, DocstoreModule],
  controllers: [CitationsController, CitationsUtilityController],
  providers: [
    // 1. Adapters bound to Ports
    {
      provide: BIBTEX_PARSER_PORT,
      useClass: RegexAstBibtexParser,
    },
    {
      provide: IDENTIFIER_RESOLVER_PORT,
      useClass: CrossrefArxivResolverAdapter,
    },
    {
      provide: CITATIONS_AGGREGATOR_PORT,
      useClass: ManuscriptBibAggregatorAdapter,
    },
    {
      provide: LIBRARY_SYNC_PORT,
      useClass: PluggableLibrarySyncAdapter,
    },

    // 2. Inbound Use Cases
    {
      provide: SearchCitationKeysUseCase,
      inject: [CITATIONS_AGGREGATOR_PORT],
      useFactory: (aggregator: ICitationsAggregatorPort) => new SearchCitationKeysUseCase(aggregator),
    },
    {
      provide: ResolveIdentifierToBibUseCase,
      inject: [IDENTIFIER_RESOLVER_PORT, CITATIONS_AGGREGATOR_PORT],
      useFactory: (resolver: IIdentifierResolverPort, aggregator: ICitationsAggregatorPort) =>
        new ResolveIdentifierToBibUseCase(resolver, aggregator),
    },
    {
      provide: ValidateProjectBibtexUseCase,
      inject: [CITATIONS_AGGREGATOR_PORT],
      useFactory: (aggregator: ICitationsAggregatorPort) => new ValidateProjectBibtexUseCase(aggregator),
    },
    {
      provide: SyncLibraryCollectionUseCase,
      inject: [LIBRARY_SYNC_PORT, BIBTEX_PARSER_PORT, CITATIONS_AGGREGATOR_PORT],
      useFactory: (
        librarySync: ILibrarySyncPort,
        bibParser: IBibtexParserPort,
        aggregator: ICitationsAggregatorPort
      ) => new SyncLibraryCollectionUseCase(librarySync, bibParser, aggregator),
    },

    // 3. Facade Service
    CitationsService,
  ],
  exports: [
    CitationsService,
    BIBTEX_PARSER_PORT,
    IDENTIFIER_RESOLVER_PORT,
    CITATIONS_AGGREGATOR_PORT,
    LIBRARY_SYNC_PORT,
  ],
})
export class CitationsModule {}
