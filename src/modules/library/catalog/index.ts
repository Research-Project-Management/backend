export * from './catalog.module';

// Controllers
export * from './controllers/items.controller';
export * from './controllers/library-workspace.controller';
export * from './controllers/collections.controller';
export * from './controllers/notes.controller';

// Services & Facade
export * from './services/library-bootstrap.service';
export * from './services/items.service';
export * from './services/item-query.service';
export * from './services/item-relations.service';
export * from './services/item-type-conversion.service';
export * from './services/item-curation.service';
export * from './services/item.transformer';
export * from './services/collections.service';
export * from './services/tags.service';
export * from './services/schema-validator.service';
export * from './services/notes.service';
export * from './services/saved-searches.service';
export * from './services/state.service';

// Repositories
export { CommandRepository } from './repositories/command.repository';
export * from './repositories/command-bulk.operations';
export * from './repositories/collection-membership.operations';
export {
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  disambiguateCitationKey,
  syncCreatedIdentifiers,
  syncUpdatedIdentifiers,
} from './repositories/command-relations.operations';
export * from './repositories/query.repository';
export * from './repositories/collections.repository';
export * from './repositories/tags.repository';
export * from './repositories/notes.repository';
export * from './repositories/saved-searches.repository';

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
export * from './types/catalog.types';

