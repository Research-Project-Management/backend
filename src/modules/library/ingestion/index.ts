export * from './ingestion.module';

// Controllers & Facade
export * from './controllers/ingestion.controller';
export * from './controllers/curation.controller';
export * from './controllers/retraction.controller';
export * from './controllers/feeds.controller';

// Services
export * from './services/ingestion.facade';
export * from './services/ingestion.service';
export * from './services/ingestion-verifier.service';
export * from './services/ingestion-saga.service';
export * from './services/pipeline.service';
export * from './services/pipeline-side-effects.service';
export * from './services/pipeline-batch.service';
export * from './services/queue.service';
export * from './services/metadata.service';
export * from './services/metadata-executor.service';
export * from './services/metadata-resolver.service';
export * from './services/url-metadata-scraper.service';
export * from './services/url-capture.service';
export * from './services/web-fetch-ladder.service';
export * from './services/domain-rate-limiter.service';
export * from './services/feed-retrieval.service';
export * from './services/duplicate-detector.service';
export * from './services/duplicate-merger.service';
export * from './services/retraction.service';
export * from './services/retraction-database.service';
export * from './services/retraction-seeder.service';
export * from './services/metadata-cache.service';
export * from './services/feeds.service';

// Repositories
export * from './repositories/ingestion.repository';
export * from './repositories/duplicate-merge.repository';
export * from './repositories/retraction.repository';
export * from './repositories/feeds.repository';

// Domain
export * from './domain/ingestion-run.domain';
export * from './domain/deduplication.domain';
export * from './domain/metadata-validation.policy';
export * from './domain/enrichment-patch.mapper';
export * from './domain/duplicate-merge.domain';

// Policies
export * from './domain/normalization.policy';
export * from './domain/metadata.policy';

// Parsers
export * from './parsers/bibtex.parser';
export * from './parsers/ris.parser';
export * from './parsers/csl.parser';
export * from './parsers/bibliography-format.registry';

// Stages
export * from './stages/identify-file.resolver';
export * from './stages/identify.stage';
export * from './stages/resolve.stage';
export * from './stages/commit.stage';

// Providers
export * from './providers/crossref.provider';
export * from './providers/arxiv.provider';
export * from './providers/dblp.provider';
export * from './providers/pubmed.provider';
export * from './providers/openalex.provider';
export * from './providers/semantic-scholar.provider';
export * from './providers/openlibrary.provider';
export * from './providers/unpaywall.provider';
export * from './providers/url-capture.provider';
export * from './providers/base-metadata.provider';
export * from './providers/retraction-scanner.provider';

// DTOs & Types
export * from './dto/ingestion.dto';
export * from './types/metadata.types';
export * from './types/ingestion.types';
