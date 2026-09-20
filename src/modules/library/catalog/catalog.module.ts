import { Module, forwardRef } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { DiscoveryModule } from '../discovery/discovery.module';

// Facade
import { CatalogFacade, CATALOG_FACADE } from './catalog.facade';

// ── 1. Items ─────────────────────────────────────────────────────────────
import { ItemsController } from './presentation/items.controller';
import { ItemsService } from './application/services/items.service';
import { QueryRepository } from './infrastructure/repositories/query.repository';
import { CommandRepository } from './infrastructure/repositories/command.repository';
import { ItemsMapper } from './infrastructure/mappers/items.mapper';
import { ItemTransformer } from './infrastructure/mappers/item.transformer';
import { ITEM_EXISTENCE_PORT, ITEM_READ_PORT } from './domain/ports/items.ports';
import { ITEM_REPOSITORY_PORT } from './domain/ports/item-repository.port';
import { PrismaItemRepositoryAdapter } from './infrastructure/adapters/prisma-item-repository.adapter';
import { CreateItemUseCase } from './application/commands/create-item/create-item.use-case';
import { UpdateItemUseCase } from './application/commands/update-item/update-item.use-case';
import { DeleteItemUseCase } from './application/commands/delete-item/delete-item.use-case';
import { RestoreItemUseCase } from './application/commands/restore-item/restore-item.use-case';
import { GetItemUseCase } from './application/queries/get-item/get-item.use-case';
import { ListItemsUseCase } from './application/queries/list-items/list-items.use-case';
import { GetFulltextUseCase } from './application/queries/get-fulltext/get-fulltext.use-case';
import { ParseCitationsUseCase } from './application/commands/parse-citations/parse-citations.use-case';
import { ReindexItemUseCase } from './application/commands/reindex-item/reindex-item.use-case';
import { ConvertItemTypeUseCase } from './application/commands/convert-item-type/convert-item-type.use-case';
import { ImportItemsToProjectUseCase } from './application/commands/import-items-to-project/import-items-to-project.use-case';

// ── 2. Collections ───────────────────────────────────────────────────────
import { CollectionsController } from './presentation/collections.controller';
import { CollectionsService } from './application/services/collections.service';
import { CollectionsRepository } from './infrastructure/repositories/collections.repository';
import { TreeEngine } from './application/engines/tree.engine';
import { COLLECTION_REPOSITORY_PORT } from './domain/ports/collection-repository.port';
import { PrismaCollectionRepositoryAdapter } from './infrastructure/adapters/prisma-collection-repository.adapter';
import { CreateCollectionUseCase } from './application/commands/create-collection/create-collection.use-case';
import { ListCollectionsUseCase } from './application/queries/list-collections/list-collections.use-case';

// ── 3. Tags ──────────────────────────────────────────────────────────────
import { TagsController } from './presentation/tags.controller';
import { TagsRepository } from './infrastructure/repositories/tags.repository';
import { TagsService } from './application/services/tags.service';
import { TAG_REPOSITORY_PORT } from './domain/ports/tag-repository.port';
import { PrismaTagRepositoryAdapter } from './infrastructure/adapters/prisma-tag-repository.adapter';
import { CreateTagUseCase } from './application/commands/create-tag/create-tag.use-case';
import { ListTagsUseCase } from './application/queries/list-tags/list-tags.use-case';

// ── 4. Types ─────────────────────────────────────────────────────────────
import { TypesController } from './presentation/types.controller';
import { TypesService } from './application/services/types.service';
import { ZoteroSchemaValidatorService } from './application/services/zotero-schema-validator.service';

// ── 5. State ─────────────────────────────────────────────────────────────
import {
  StateController,
  StateBatchController,
} from './presentation/state.controller';
import { StateService } from './application/services/state.service';
import { StateRepository } from './infrastructure/repositories/state.repository';

// ── 6. Saved Searches ────────────────────────────────────────────────────
import { SavedSearchesController } from './presentation/saved-searches.controller';
import { SavedSearchesService } from './application/services/saved-searches.service';
import { SavedSearchesRepository } from './infrastructure/repositories/saved-searches.repository';
import { ConditionEvaluatorEngine } from './application/engines/condition-evaluator.engine';

/**
 * Catalog Bounded Context Unified Module (Core Domain).
 *
 * Consolidates all catalog features into a single Clean Architecture module:
 * - Items (CRUD, Use Cases, Ports/Adapters)
 * - Collections (Hierarchy, Tree Engine, Ports/Adapters)
 * - Tags (Management, Caching, Ports/Adapters)
 * - Types (Zotero Schema Validation)
 * - State (Trash, Pin, Archive, Read status)
 * - Saved Searches (Smart Filters, Condition Evaluation)
 */
@Module({
  imports: [CoreModule, SharedKernelModule, forwardRef(() => DiscoveryModule)],
  controllers: [
    ItemsController,
    CollectionsController,
    TagsController,
    TypesController,
    StateController,
    StateBatchController,
    SavedSearchesController,
  ],
  providers: [
    // Facade
    CatalogFacade,
    {
      provide: CATALOG_FACADE,
      useExisting: CatalogFacade,
    },

    // ── Items Providers ────────────────────────────────────────────────
    QueryRepository,
    CommandRepository,
    ItemsService,
    ItemsMapper,
    ItemTransformer,
    {
      provide: ITEM_EXISTENCE_PORT,
      useExisting: ItemsService,
    },
    {
      provide: ITEM_READ_PORT,
      useExisting: ItemsService,
    },
    PrismaItemRepositoryAdapter,
    {
      provide: ITEM_REPOSITORY_PORT,
      useClass: PrismaItemRepositoryAdapter,
    },
    CreateItemUseCase,
    UpdateItemUseCase,
    DeleteItemUseCase,
    RestoreItemUseCase,
    GetItemUseCase,
    ListItemsUseCase,
    GetFulltextUseCase,
    ParseCitationsUseCase,
    ReindexItemUseCase,
    ConvertItemTypeUseCase,
    ImportItemsToProjectUseCase,

    // ── Collections Providers ──────────────────────────────────────────
    CollectionsRepository,
    CollectionsService,
    TreeEngine,
    PrismaCollectionRepositoryAdapter,
    {
      provide: COLLECTION_REPOSITORY_PORT,
      useClass: PrismaCollectionRepositoryAdapter,
    },
    CreateCollectionUseCase,
    ListCollectionsUseCase,

    // ── Tags Providers ─────────────────────────────────────────────────
    TagsRepository,
    TagsService,
    PrismaTagRepositoryAdapter,
    {
      provide: TAG_REPOSITORY_PORT,
      useClass: PrismaTagRepositoryAdapter,
    },
    CreateTagUseCase,
    ListTagsUseCase,

    // ── Types Providers ────────────────────────────────────────────────
    TypesService,
    ZoteroSchemaValidatorService,

    // ── State Providers ────────────────────────────────────────────────
    StateRepository,
    StateService,

    // ── Saved Searches Providers ───────────────────────────────────────
    SavedSearchesService,
    SavedSearchesRepository,
    ConditionEvaluatorEngine,
  ],
  exports: [
    // Facade
    CatalogFacade,
    CATALOG_FACADE,

    // Domain Ports
    ITEM_REPOSITORY_PORT,
    COLLECTION_REPOSITORY_PORT,
    TAG_REPOSITORY_PORT,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
  ],

})
export class CatalogModule {}
