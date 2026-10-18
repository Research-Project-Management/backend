export * from './ingestion.module';
export * from './ingestion.facade';

// Controllers
export * from './controllers/ingestion.controller';
export * from './controllers/curation.controller';
export * from './controllers/retraction.controller';

// Domain
export * from './domain/ingestion-status.vo';
export * from './domain/ingestion-domain.event';
export * from './domain/ingestion-run.aggregate';
export * from './domain/deduplication.domain';
export * from './domain/metadata.validator';

// DTOs
export * from './dto/ingestion.dto';
export * from './dto/submission.dto';
export * from './dto/curation.dto';
export * from './dto/retraction.dto';
export * from './dto/capture-url.dto';

// Services
export * from './services/url-metadata-scraper.service';
export * from './services/metadata-executor.service';
export * from './services/metadata-reconciliation.service';
export * from './services/metadata.service';
export * from './services/retraction-database.service';
export * from './services/retraction-sync.service';
export * from './services/retraction.service';
export * from './services/duplicate.service';
export * from './services/quality.service';
export * from './services/url-capture.service';
export * from './services/ingestion-saga.orchestrator';
export * from './services/pipeline.service';
export * from './services/queue.service';
export * from './services/ingestion-queue.consumer';
export * from './services/ingestion.service';
export * from './services/ingestion-verifier.service';
export * from './services/web-fetch-ladder.service';
export * from './services/domain-rate-limiter.service';
export * from './services/external-search-comparator.service';

// Repositories
export * from './repositories/ingestion.repository';
export * from './repositories/idempotency.repository';
export * from './repositories/retraction.repository';
export * from './repositories/metadata.cache';

// Parsers
export * from './parsers/bibtex.parser';
export * from './parsers/ris.parser';
export * from './parsers/doi.parser';
export * from './parsers/query.classifier';
export * from './parsers/csl.parser';
export * from './parsers/rss-atom-feed.parser';

// Policies
export * from './policies/normalization.policy';
export * from './policies/duplicate.policy';
export * from './policies/reconciliation.policy';
export * from './policies/metadata.policy';

// Stages
export * from './stages/identify.stage';
export * from './stages/normalize.stage';
export * from './stages/enrich.stage';
export * from './stages/reconcile.stage';
export * from './stages/match.stage';
export * from './stages/commit.stage';

// Providers
export * from './providers/crossref.provider';
export * from './providers/arxiv.provider';
export * from './providers/pubmed.provider';
export * from './providers/openalex.provider';
export * from './providers/openlibrary.provider';
export * from './providers/unpaywall.provider';
export * from './providers/url-capture.provider';
export * from './providers/retraction-scanner.provider';
export * from './providers/searxng.provider';
export * from './providers/europe-pmc-search.provider';
export * from './providers/dblp.provider';
export * from './providers/semantic-scholar.provider';

// Subscribers
export * from './subscribers/retraction-item-events.subscriber';

// Types
export * from './types/queue.constants';
export * from './types/retraction.types';
export * from './types/metadata.types';
export * from './types/submission.types';
export type {
  FieldEvidence,
  MetadataConflictDetail,
  ReconciliationDecision,
  DuplicateMatchResult,
} from './types/metadata-candidate.types';
export * from './types/ingestion.types';
export * from './types/ingestion.errors';
export * from './types/curation.types';
export * from './types/web-fetch.types';
export * from './types/external-search.types';
export * from './types/workflow-stage.types';
