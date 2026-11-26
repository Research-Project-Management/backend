import { Global, Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';
import { FilesModule } from '@/modules/files/files.module';

// Controllers
import { ItemsController } from './controllers/items.controller';
import { LibraryWorkspaceController } from './controllers/workspace.controller';
import { ItemCurationController } from './controllers/curation.controller';
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
import { ItemCacheCoordinator } from './services/item-cache.service';
import { ItemQueryService } from './services/item-query.service';
import { ItemFulltextService } from './services/relations.service';
import { ItemTypeConversionService } from './services/type-conversion.service';
import { ItemCurationService } from './services/curation.service';
import { ItemRelationsService } from './services/relations.service';
import { CollectionsService } from './services/collections.service';
import { TagsService } from './services/tags.service';
import { TypesService } from './services/types.service';
import { LibraryBootstrapService } from './services/bootstrap.service';
import { ReaderBootstrapService } from './services/reader-bootstrap.service';
import { ReaderWriteBehindService } from './services/reader-write-behind.service';
import { StateService } from './services/state.service';
import { SavedSearchesService } from './services/saved-searches.service';
import { SchemaValidatorService } from './services/schema-validator.service';
import { NotesService } from './services/notes.service';
import { TrashMaintenanceService } from './services/trash-maintenance.service';

// Engines & Mappers
import { TreeEngine } from './domain/state.domain';
import { ConditionEvaluatorEngine } from './domain/condition-evaluator.policy';
import { ItemsMapper } from '@/modules/library/core';
import { ItemTransformer } from './services/item-transformer.service';

// Repositories
import { CommandRepository } from './repositories/command.repository';
import { QueryRepository } from './repositories/query.repository';
import { ItemMatchQueryRepository } from './repositories/item-match-query.repository';
import { ItemListQueryRepository } from './repositories/item-list-query.repository';
import { CollectionsRepository } from './repositories/collections.repository';
import { TagsRepository } from './repositories/tags.repository';
import { StateRepository } from './repositories/state.repository';
import { SavedSearchesRepository } from './repositories/saved-searches.repository';
import { NotesRepository } from './repositories/notes.repository';

// Facade
import {
  CatalogFacade,
  CATALOG_FACADE,
} from './services/catalog.facade';
import { ITEM_CACHE_INVALIDATOR } from '@/modules/library/core';

@Global()
@Module({
  imports: [CoreModule, LibraryCoreModule, FilesModule],
  controllers: [
    ItemCurationController,
    ItemsController,
    LibraryWorkspaceController,
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
    ItemCacheCoordinator,
    {
      provide: ITEM_CACHE_INVALIDATOR,
      useExisting: ItemCacheCoordinator,
    },
    ItemService,
    CollectionsService,
    TagsService,
    TypesService,
    StateService,
    SavedSearchesService,
    SchemaValidatorService,
    NotesService,
    TrashMaintenanceService,
    LibraryBootstrapService,
    ReaderBootstrapService,
    ReaderWriteBehindService,

    // Engines & Mappers
    TreeEngine,
    ConditionEvaluatorEngine,
    ItemsMapper,
    ItemTransformer,

    // Repositories
    CommandRepository,
    ItemMatchQueryRepository,
    ItemListQueryRepository,
    QueryRepository,
    CollectionsRepository,
    TagsRepository,
    StateRepository,
    SavedSearchesRepository,
    NotesRepository,
  ],
  exports: [
    CATALOG_FACADE,
    CatalogFacade,
    ITEM_CACHE_INVALIDATOR,
    ReaderWriteBehindService,
    TrashMaintenanceService,
  ],
})
export class CatalogModule {}
