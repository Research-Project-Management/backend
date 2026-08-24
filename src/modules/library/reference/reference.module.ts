import { Module, forwardRef } from '@nestjs/common';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import { BibtexFormatter } from './formatters/bibtex.formatter';
import { BibtexParser } from './parsers/bibtex.parser';
import { DoiResolver } from './resolvers/doi.resolver';
import { SemanticScholarFetcher } from './fetchers/semantic-scholar.fetcher';
import { ArxivFetcher } from './fetchers/arxiv.fetcher';
import { PubmedFetcher } from './fetchers/pubmed.fetcher';
import { OpenlibraryFetcher } from './fetchers/openlibrary.fetcher';
import { OpenAlexFetcher } from './fetchers/openalex.fetcher';
import { UnpaywallFetcher } from './fetchers/unpaywall.fetcher';
import { UnifiedFetcherService } from './fetchers/unified-fetcher.service';
import { CslFormatter } from './formatters/csl.formatter';
import { RisFormatter } from './formatters/ris.formatter';
import { PaperModule } from '../paper/paper.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [forwardRef(() => PaperModule), forwardRef(() => IngestionModule)],
  controllers: [ReferenceController],
  providers: [
    ReferenceService,
    BibtexFormatter,
    CslFormatter,
    RisFormatter,
    BibtexParser,
    DoiResolver,
    SemanticScholarFetcher,
    ArxivFetcher,
    PubmedFetcher,
    OpenlibraryFetcher,
    OpenAlexFetcher,
    UnpaywallFetcher,
    UnifiedFetcherService,
  ],
  exports: [
    ReferenceService,
    BibtexFormatter,
    CslFormatter,
    RisFormatter,
    BibtexParser,
    DoiResolver,
    SemanticScholarFetcher,
    ArxivFetcher,
    PubmedFetcher,
    OpenlibraryFetcher,
    OpenAlexFetcher,
    UnpaywallFetcher,
    UnifiedFetcherService,
  ],
})
export class ReferenceModule {}
