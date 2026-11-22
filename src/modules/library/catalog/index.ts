export * from './catalog.module';

// Controllers
export * from './controllers/items.controller';
export * from './controllers/workspace.controller';
export * from './controllers/collections.controller';
export * from './controllers/curation.controller';
export * from './controllers/notes.controller';
export * from './controllers/tags.controller';
export * from './controllers/saved-searches.controller';
export * from './controllers/types.controller';
export * from './controllers/state.controller';

// Services & Facade
export * from './services/catalog.facade';
export * from './services/bootstrap.service';
export * from './services/items.service';
export * from './services/item-query.service';
export * from './services/relations.service';
export * from './services/type-conversion.service';
export * from './services/curation.service';
export * from './services/item-transformer.service';
export * from './services/collections.service';
export * from './services/tags.service';
export * from './services/types.service';
export * from './services/item-cache.service';
export * from './services/schema-validator.service';
export * from './services/notes.service';
export * from './services/saved-searches.service';
export * from './services/state.service';

// Repositories
export { CommandRepository } from './repositories/command.repository';
export * from './repositories/command-bulk.repository';
export * from './repositories/collection-members.repository';
export {
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  syncCreatedIdentifiers,
  syncUpdatedIdentifiers,
} from './repositories/command-relations.repository';
export { disambiguateCitationKey } from '@/modules/library/core/domain/specification.domain';
export * from './repositories/query.repository';
export * from './repositories/collections.repository';
export * from './repositories/tags.repository';
export * from './repositories/notes.repository';
export * from './repositories/saved-searches.repository';
export * from './repositories/state.repository';

// Domain
export * from './domain/state.domain';
export * from './domain/condition-evaluator.policy';
export * from './domain/notes.domain';
export * from './domain/item-command.mapper';
export * from './domain/creator-tag.mapper';
export * from './domain/match-specifications.domain';
export * from './domain/type-conversion.policy';

// DTOs & Types
export * from './dto/items.dto';
export * from './dto/collections.dto';
export * from './dto/notes.dto';
export * from './dto/tags.dto';
export * from './dto/state.dto';
export * from './dto/saved-searches.dto';
export * from './types/catalog.types';
