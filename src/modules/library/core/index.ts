export * from './core.module';

// Configuration
export * from './config/library.config';

// Domain
export * from './domain/scope.specification';
export * from './domain/identifier.domain';
export * from './domain/author.domain';
export * from './domain/author-particles.lexicon';
export * from './domain/academic-item-types.domain';
export * from './domain/academic-title.domain';
export * from './domain/academic-text.domain';
export * from './domain/academic-text.lexicon';
export * from './domain/tag.domain';
export * from './domain/tag-taxonomy.lexicon';
export * from './domain/academic-regex.catalog';
export * from './domain/sort-index.domain';
export * from './domain/tiptap.domain';
export * from './domain/zotero-field-harmonizer.domain';

// Constants
export * from './constants/academic-client.constants';
export * from './constants/redis-keys.constants';

// Errors
export * from './errors/domain.exception';
export * from './errors/version-mismatch.exception';

// Services
export * from './services/ssrf-guard.service';
export * from './services/academic-http.client';

// Types & Schemas
export * from './types/branded.types';
export * from './types/bibliographic.types';
export * from './types/schema.constants';
export * from './types/schema.types';
export * from './types/extraction.types';
export * from './types/ingestion.types';

// Events
export * from './events/library-events';

// Ports
export * from './ports/catalog.port';
export * from './ports/extraction.port';
export * from './ports/ingestion.port';
export * from './ports/unit-of-work.port';
export * from './ports/outbox.port';
export * from './ports/idempotent-consumer.port';

// Resilience
export * from './resilience/circuit-breaker';
export * from './resilience/rate-limiter';
export * from './resilience/resilience-registry.service';

// Streaming & OS Buffer Protection
export * from './utils/stream-buffer.util';
