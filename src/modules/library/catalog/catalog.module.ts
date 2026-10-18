import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';

// Controllers
import {
  ItemController,
  ProjectItemController,
  LibraryPermissionsController,
} from './controllers/items.controller';
import {
  ItemCurationController,
  ProjectItemCurationController,
} from './controllers/item-curation.controller';
import {
  CollectionController,
  ProjectCollectionController,
} from './controllers/collections.controller';
import { TagController } from './controllers/tags.controller';
import { TypeController } from './controllers/types.controller';
import {
  StateController,
  ProjectStateController,
  StateBatchController,
  ProjectStateBatchController,
} from './controllers/state.controller';
import {
  SavedSearchesController,
  ProjectSavedSearchesController,
} from './controllers/saved-searches.controller';
import { NoteController } from './controllers/notes.controller';

// Services
import { ItemService } from './services/items.service';
import { ItemQueryService } from './services/item-query.service';
import { ItemFulltextService } from './services/item-fulltext.service';
import { ItemTypeConversionService } from './services/item-type-conversion.service';
import { ItemCurationService } from './services/item-curation.service';
import { ItemRelationsService } from './services/item-relations.service';
import { ItemBulkService } from './services/item-bulk.service';
import { ItemCacheService } from './services/item-cache.service';
import { ItemLifecycleService } from './services/item-lifecycle.service';
import { ItemSyncDelegate } from './services/item-sync.delegate';
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
// Ports
import { ITEM_EXISTENCE_PORT, ITEM_READ_PORT } from './types/items.types';

// Facade
import { CatalogFacade, CATALOG_FACADE } from './catalog.facade';

@Module({
  imports: [CoreModule, LibraryCoreModule],
  controllers: [
    ItemCurationController,
    ProjectItemCurationController,
    ItemController,
    ProjectItemController,
    LibraryPermissionsController,
    CollectionController,
    ProjectCollectionController,
    TagController,
    TypeController,
    StateController,
    ProjectStateController,
    StateBatchController,
    ProjectStateBatchController,
    SavedSearchesController,
    ProjectSavedSearchesController,
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
    ItemBulkService,
    ItemCacheService,
    ItemLifecycleService,
    ItemService,
    ItemSyncDelegate,
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

    // Ports
    {
      provide: ITEM_EXISTENCE_PORT,
      useExisting: ItemQueryService,
    },
    {
      provide: ITEM_READ_PORT,
      useExisting: ItemQueryService,
    },
  ],
  exports: [
    CatalogFacade,
    CATALOG_FACADE,
    ItemQueryService,
    ItemFulltextService,
    ItemTypeConversionService,
    ItemCurationService,
    ItemService,
    ItemSyncDelegate,
    CollectionsService,
    TagsService,
    TypesService,
    StateService,
    SavedSearchesService,
    NotesService,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
  ],
})
export class CatalogModule {}
