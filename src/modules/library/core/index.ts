export * from './core.module';

// Configuration
export * from './config/library.config';

// Domain
export * from './domain/specification.domain';
export * from './domain/identifier.domain';
export * from './domain/author.domain';
export * from './domain/creator-normalizer.domain';
export * from './domain/author-particles.lexicon';
export * from './domain/academic-item-types.domain';
export * from './domain/academic-title.domain';
export * from './domain/academic-text.domain';
export * from './domain/academic-text.lexicon';
export * from './domain/tag.domain';
export * from './domain/tag-taxonomy.lexicon';
export * from './domain/academic-regex.catalog';
export * from './domain/tiptap.domain';
export * from './domain/zotero-field-harmonizer.domain';
export * from './domain/renamer.domain';
export * from './domain/metadata-coalesce.policy';
export * from './domain/item-provenance.domain';
export * from './domain/academic-search-query.domain';
export * from './domain/item-bibliographic.mapper';
export * from './domain/items.mapper';

// Constants
export * from './constants/redis-keys.constants';

// Errors
export * from './errors/domain.exception';

// Services
export * from './services/ssrf-guard.service';
export * from './services/academic-http.client';

// Types & Schemas
export * from './types/bibliographic.types';
export * from './types/schema.constants';
export * from './types/schema.types';
export * from './types/extraction.types';
export * from './types/ingestion.types';

// Events
export * from './events/library-events';

// Ports
export * from './ports';

// Resilience
export * from './resilience/circuit-breaker';
export * from './resilience/rate-limiter';
export * from './resilience/resilience-registry.service';

// Utilities, Streaming & Cache Invalidation
export * from './utils/cache-invalidation.helper';
