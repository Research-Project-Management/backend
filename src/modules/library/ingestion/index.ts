export * from './ingestion.module';
export * from './ingestion.facade';

// Controllers
export * from './controllers/ingestion.controller';
export * from './controllers/curation.controller';
export * from './controllers/retraction.controller';
export * from './controllers/feeds.controller';

// Domain
export * from './domain/ingestion-run.aggregate';
export * from './domain/deduplication.domain';
export * from './domain/metadata.validator';
export * from './domain/enrichment-patch.builder';
export * from './domain/duplicate-merge.steps';
export * from './domain/candidate-builder.helper';

// DTOs
export * from './dto/ingestion.dto';
export * from './dto/submission.dto';
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
export * from './services/metadata.service';
export * from './services/metadata-executor.service';
export * from './services/metadata-resolver.service';
export * from './services/url-metadata-scraper.service';
export * from './services/url-capture.service';
export * from './services/web-fetch-ladder.service';
export * from './services/domain-rate-limiter.service';
export * from './services/duplicate-detector.service';
export * from './services/duplicate-merger.service';
export * from './services/retraction.service';
export * from './services/retraction-database.service';
export * from './services/retraction-sync.service';
export * from './services/feeds.service';
export * from './services/feed-retrieval.service';

// Repositories
export * from './repositories/ingestion.repository';
export * from './repositories/retraction.repository';
export * from './repositories/feeds.repository';
export * from './repositories/metadata.cache';

// Parsers
export * from './parsers/bibtex.parser';
export * from './parsers/ris.parser';
export * from './parsers/csl.parser';
export * from './parsers/bibliography-format.registry';

// Policies
export * from './policies/normalization.policy';
export * from './policies/metadata.policy';
export {
  MetadataCoalescePolicy,
  PREPRINT_SERVER_VENUE_REGEX,
  ALIAS_EVIDENCE_FALLBACK_KEYS,
  countFullGivenNames,
  isBetterAuthorListCandidate,
  selectAuthoritativeCreatorVariant,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  finalizeReconciledBibliographicMetadata,
  finalizeBibliographicMetadata,
  evaluateCitationTrap,
  verifyTitleLookupCorroboration,
  verifyCandidateMatch,
  extractNormalizedAuthorSurnames,
} from '@/modules/library/core';

// Stages
export * from './stages/identify.stage';
export * from './stages/resolve.stage';
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
export * from './types/metadata.types';
export * from './types/ingestion.types';
export * from './types/ingestion.errors';
