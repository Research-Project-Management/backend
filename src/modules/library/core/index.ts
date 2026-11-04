export * from './core.module';

// Configuration
export * from './config/library.config';

// Domain
export * from './domain/specification.domain';
export * from './domain/identifier.domain';
export * from './domain/author.domain';
export * from './domain/creator-normalizer.domain';
export * from './domain/author-particles.lexicon';
export * from './domain/title.domain';
export * from './domain/text.domain';
export * from './domain/text.lexicon';
export * from './domain/tag.domain';
export * from './domain/tag-taxonomy.lexicon';
export * from './domain/regex.extractor';
export * from './domain/renamer.domain';
export * from './domain/zotero-field-harmonizer.domain';
export * from './domain/metadata-coalesce.policy';
export * from './domain/item-provenance.domain';
export * from './domain/search-query.domain';
export * from './domain/item-bibliographic.mapper';
export * from './domain/items.mapper';

// Constants

// Errors
export * from './errors/domain.exception';

// Services
export * from './services/ssrf-guard.service';

// Types & Schemas
export * from './types/bibliographic.types';
export * from './types/schema.constants';
export * from './types/schema.types';
export * from './types/extraction.types';

// Events

// Ports
export * from './ports';

// Resilience
export * from './resilience/circuit-breaker';
export * from './resilience/resilience-registry.service';

// Utilities, Streaming & Cache Invalidation
export * from './utils/transaction-helpers';

