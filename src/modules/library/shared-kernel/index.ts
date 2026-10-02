export * from './shared-kernel.module';

// Core
export * from './core/constants/academic-client.constants';
export * from './core/constants/redis-keys.constants';
export * from './core/errors/domain.exception';
export * from './core/errors/version-mismatch.exception';
export * from './core/filters/domain-exception.filter';
export * from './core/middlewares/correlation-id.middleware';
export * from './core/middlewares/idempotency.middleware';
export * from './core/services/ssrf-guard.service';
export * from './core/types/branded.types';
export * from './core/types/entity-commands.types';

// Events
export * from './events/integration-event-bus.service';
export * from './events/integration-events';

// Infra
export * from './infra/grobid/grobid.client';
export * from './infra/zotero/zotero-translator.client';

// Resilience
export * from './resilience/circuit-breaker';
export * from './resilience/rate-limiter';
export * from './resilience/resilience-registry.service';

// Types & Schemas
export type {
  CreatorType,
  CreatorCredit,
  CreatorCreditInput,
  CreatorInput,
  ParsedCreator,
  IdentifierScheme,
  TagObjectInput,
  TagInput,
  CreateItemData,
} from './types/bibliographic.types';
export { ITEM_COLUMN_METADATA_FIELDS } from './types/bibliographic.types';
export * from './types/schema.constants';
export * from './types/schema.types';

// Utilities
export * from './utils/bibliographic.utils';
export * from './utils/tag.utils';
export * from './utils/project-scope.utils';
