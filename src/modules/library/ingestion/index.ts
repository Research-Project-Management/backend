export * from './ingestion.module';
export * from './ingestion.facade';

// Controllers
export * from './controllers/ingestion.controller';
export * from './controllers/curation.controller';
export * from './controllers/retraction.controller';
export * from './controllers/feeds.controller';

// Domain
export * from './domain/ingestion-status.vo';
export * from './domain/ingestion-run.aggregate';
export * from './domain/deduplication.domain';
export * from './domain/metadata.validator';
export * from './domain/enrichment-patch.builder';
export * from './domain/duplicate-merge.steps';
export * from './domain/duplicate-merge.memento';
export * from './domain/field-reconciliation.strategies';

// DTOs
export * from './dto/ingestion.dto';
export * from './dto/submission.dto';
export * from './dto/curation.dto';
export * from './dto/retraction.dto';
export * from './dto/capture-url.dto';

// Services
export * from './services/ingestion.service';
export * from './services/ingestion-verifier.service';
export * from './services/ingestion-saga.orchestrator';
export * from './services/ingestion-run-reporter.service';
export * from './services/pipeline.service';
export * from './services/pipeline-side-effects.service';
export * from './services/pipeline-batch.executor';
export * from './services/queue.service';
export * from './services/ingestion-queue.consumer';
export * from './services/metadata.service';
export * from './services/metadata-executor.service';
export * from './services/metadata-reconciliation.service';
export * from './services/metadata-resolver.service';
export * from './services/url-metadata-scraper.service';
export * from './services/url-capture.service';
export * from './services/web-fetch-ladder.service';
export * from './services/domain-rate-limiter.service';
export * from './services/duplicate-detector.service';
export * from './services/duplicate-merger.service';
export * from './services/quality.service';
export * from './services/retraction.service';
export * from './services/retraction-database.service';
export * from './services/retraction-sync.service';
export * from './services/feeds.service';
export * from './services/feeds.engine';
export * from './services/feed-retrieval.service';

// Repositories
export * from './repositories/ingestion.repository';
export * from './repositories/retraction.repository';
export * from './repositories/feeds.repository';
export * from './repositories/metadata.cache';

// Parsers
export * from './parsers/bibtex.parser';
export * from './parsers/ris.parser';
export * from './parsers/doi.parser';
export * from './parsers/query.classifier';
export * from './parsers/csl.parser';
export * from './parsers/bibliography-format.registry';

// Policies
export * from './policies/normalization.policy';
export * from './policies/duplicate.policy';
export * from './policies/reconciliation.policy';
export * from './policies/metadata.policy';

// Stages
export * from './stages/identify.stage';
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
export * from './providers/dblp.provider';
export * from './providers/semantic-scholar.provider';

// Subscribers
export * from './subscribers/retraction-item-events.subscriber';

// Types
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
export * from './types/workflow-stage.types';
