import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';

// Controllers
import {
  ItemController,
  ProjectItemController,
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
import { ItemSyncDelegate } from './services/item-sync.delegate';
import { CollectionsService } from './services/collections.service';
import { TagsService } from './services/tags.service';
import { TypesService } from './services/types.service';
import { StateService } from './services/state.service';
import { SavedSearchesService } from './services/saved-searches.service';
import { ZoteroSchemaValidatorService } from './services/zotero-schema-validator.service';
import { NotesService } from './services/notes.service';

// Engines & Mappers
import { TreeEngine } from './utils/tree.engine';
import { ConditionEvaluatorEngine } from './utils/condition-evaluator.engine';
import { ItemsMapper } from './utils/items.mapper';
import { ItemTransformer } from './utils/item.transformer';

// Repositories
import { CommandRepository } from './repositories/command.repository';
import { QueryRepository } from './repositories/query.repository';
import { CollectionsRepository } from './repositories/collections.repository';
import { TagsRepository } from './repositories/tags.repository';
import { StateRepository } from './repositories/state.repository';
import { SavedSearchesRepository } from './repositories/saved-searches.repository';
import { NotesRepository } from './repositories/notes.repository';
import { PrismaItemRepositoryAdapter } from './repositories/prisma-item-repository.adapter';

// Clean Architecture Use Cases & Ports
import { CreateItemUseCase } from './core/use-cases/create-item.use-case';
import { UpdateItemUseCase } from './core/use-cases/update-item.use-case';
import { DeleteItemUseCase } from './core/use-cases/delete-item.use-case';
import { GetItemUseCase } from './core/use-cases/get-item.use-case';
import { ListItemsUseCase } from './core/use-cases/list-items.use-case';
import { RestoreItemUseCase } from './core/use-cases/restore-item.use-case';
import { ITEM_REPOSITORY_PORT } from './core/ports/item-repository.port';

// Ports
import {
  ITEM_EXISTENCE_PORT,
  ITEM_READ_PORT,
  ITEM_TRANSFORMER_PORT,
} from './types/items.types';

// Facade
import { CatalogFacade, CATALOG_FACADE } from './catalog.facade';

@Module({
  imports: [CoreModule, SharedKernelModule],
  controllers: [
    ItemCurationController,
    ProjectItemCurationController,
    ItemController,
    ProjectItemController,
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
    {
      provide: ITEM_TRANSFORMER_PORT,
      useExisting: ItemTransformer,
    },

    // Repositories
    CommandRepository,
    QueryRepository,
    CollectionsRepository,
    TagsRepository,
    StateRepository,
    SavedSearchesRepository,
    NotesRepository,
    PrismaItemRepositoryAdapter,
    {
      provide: ITEM_REPOSITORY_PORT,
      useClass: PrismaItemRepositoryAdapter,
    },

    // Clean Architecture Use Cases
    CreateItemUseCase,
    UpdateItemUseCase,
    DeleteItemUseCase,
    GetItemUseCase,
    ListItemsUseCase,
    RestoreItemUseCase,

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
    ITEM_TRANSFORMER_PORT,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
    ITEM_REPOSITORY_PORT,
    CreateItemUseCase,
    UpdateItemUseCase,
    DeleteItemUseCase,
    GetItemUseCase,
    ListItemsUseCase,
    RestoreItemUseCase,
  ],
})
export class CatalogModule {}
