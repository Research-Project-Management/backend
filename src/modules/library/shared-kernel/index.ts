// Utilities (exported first to prevent circular dependency timing issues)
export * from './utils/bibliographic.utils';
export * from './utils/tag.utils';
export * from './utils/academic-regex.catalog';
export * from './utils/sort-index.utils';
export * from './utils/tiptap.utils';

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
  ItemMetadata,
} from './types/bibliographic.types';
export { ITEM_COLUMN_METADATA_FIELDS } from './types/bibliographic.types';
export * from './types/schema.constants';
export * from './types/schema.types';

// Events
export * from './events/integration-event-bus.service';
export * from './events/integration-events';
export * from './events/library-events';

// Ports
export * from './ports';

// Resilience
export * from './resilience/circuit-breaker';
export * from './resilience/rate-limiter';
export * from './resilience/resilience-registry.service';

// Module (exported last after all primitives)
export * from './shared-kernel.module';
