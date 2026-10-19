import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';

// Controllers
import {
  ItemsController,
  LibraryPermissionsController,
} from './controllers/items.controller';
import { ItemCurationController } from './controllers/item-curation.controller';
import { CollectionsController } from './controllers/collections.controller';
import { TagController } from './controllers/tags.controller';
import { TypeController } from './controllers/types.controller';
import {
  StateController,
  StateBatchController,
} from './controllers/state.controller';
import { SavedSearchesController } from './controllers/saved-searches.controller';
import { NoteController } from './controllers/notes.controller';

// Services
import { ItemService } from './services/items.service';
import { ItemQueryService } from './services/item-query.service';
import { ItemFulltextService } from './services/item-fulltext.service';
import { ItemTypeConversionService } from './services/item-type-conversion.service';
import { ItemCurationService } from './services/item-curation.service';
import { ItemRelationsService } from './services/item-relations.service';
import { CollectionsService } from './services/collections.service';
import { TagsService } from './services/tags.service';
import { TypesService } from './services/types.service';
import { StateService } from './services/state.service';
import { SavedSearchesService } from './services/saved-searches.service';
import { ZoteroSchemaValidatorService } from './services/zotero-schema-validator.service';
import { NotesService } from './services/notes.service';

// Engines & Mappers
import { TreeEngine } from './domain/tree.engine';
import { ConditionEvaluatorEngine } from './domain/condition-evaluator.engine';
import { ItemsMapper } from './domain/items.mapper';
import { ItemTransformer } from './domain/item.transformer';

// Repositories
import { CommandRepository } from './repositories/command.repository';
import {
  QueryRepository,
  ItemMatchQueryRepository,
  ItemRelationsQueryRepository,
  ItemListQueryRepository,
} from './repositories/query.repository';
import { CollectionsRepository } from './repositories/collections.repository';
import { TagsRepository } from './repositories/tags.repository';
import { StateRepository } from './repositories/state.repository';
import { SavedSearchesRepository } from './repositories/saved-searches.repository';
import { NotesRepository } from './repositories/notes.repository';

// Facade
import { CatalogFacade, CATALOG_FACADE } from './catalog.facade';

@Module({
  imports: [CoreModule, LibraryCoreModule],
  controllers: [
    ItemCurationController,
    ItemsController,
    LibraryPermissionsController,
    CollectionsController,
    TagController,
    TypeController,
    StateController,
    StateBatchController,
    SavedSearchesController,
    NoteController,
  ],
  providers: [
    // Facades
    CatalogFacade,
    {
      provide: CATALOG_FACADE,
      useExisting: CatalogFacade,
    },

    // Services
    ItemQueryService,
    ItemFulltextService,
    ItemTypeConversionService,
    ItemCurationService,
    ItemRelationsService,
    ItemService,
    CollectionsService,
    TagsService,
    TypesService,
    StateService,
    SavedSearchesService,
    ZoteroSchemaValidatorService,
    NotesService,

    // Engines & Mappers
    TreeEngine,
    ConditionEvaluatorEngine,
    ItemsMapper,
    ItemTransformer,

    // Repositories
    CommandRepository,
    ItemMatchQueryRepository,
    ItemRelationsQueryRepository,
    ItemListQueryRepository,
    QueryRepository,
    CollectionsRepository,
    TagsRepository,
    StateRepository,
    SavedSearchesRepository,
    NotesRepository,
  ],
  exports: [CATALOG_FACADE, CatalogFacade],
})
export class CatalogModule {}
