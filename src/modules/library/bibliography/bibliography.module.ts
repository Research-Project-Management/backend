import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';

// Facade
import {
  BibliographyFacade,
  BIBLIOGRAPHY_FACADE,
  CatalogFacade,
  CATALOG_FACADE,
} from './bibliography.facade';

// ── 1. Items ─────────────────────────────────────────────────────────────
import { ItemsController } from './presentation/items.controller';
import { ItemsService } from './application/services/items.service';
import { ItemSyncDelegate } from './application/services/item-sync.delegate';
import { QueryRepository } from './infrastructure/repositories/query.repository';
import { CommandRepository } from './infrastructure/repositories/command.repository';
import { ItemsMapper } from './infrastructure/mappers/items.mapper';
import { ItemTransformer } from './infrastructure/mappers/item.transformer';
import {
  ITEM_EXISTENCE_PORT,
  ITEM_READ_PORT,
} from './domain/ports/items.ports';
import { ITEM_REPOSITORY_PORT } from './domain/ports/item-repository.port';
import { ITEM_TRANSFORMER_PORT } from './domain/ports/item-transformer.port';
import { FULLTEXT_QUERY_PORT } from './domain/ports/fulltext-query.port';
import { PrismaItemRepositoryAdapter } from './infrastructure/adapters/prisma-item-repository.adapter';
import { CreateItemUseCase } from './application/commands/create-item.use-case';
import { UpdateItemUseCase } from './application/commands/update-item.use-case';
import { DeleteItemUseCase } from './application/commands/delete-item.use-case';
import { RestoreItemUseCase } from './application/commands/restore-item.use-case';
import { GetItemUseCase } from './application/queries/get-item.use-case';
import { ListItemsUseCase } from './application/queries/list-items.use-case';
import { GetFulltextUseCase } from './application/queries/get-fulltext.use-case';
import { ParseCitationsUseCase } from './application/commands/parse-citations.use-case';
import { ReindexItemUseCase } from './application/commands/reindex-item.use-case';
import { ConvertItemTypeUseCase } from './application/commands/convert-item-type.use-case';
import { ImportItemsToProjectUseCase } from './application/commands/import-items-to-project.use-case';
import { PurgeItemUseCase } from './application/commands/purge-item.use-case';
import { SetMyPublicationUseCase } from './application/commands/set-my-publication.use-case';
import { ManageRelationsUseCase } from './application/commands/manage-relations.use-case';
import { PreviewTypeConversionUseCase } from './application/queries/preview-type-conversion.use-case';
import { CITATION_PARSER_PORT } from './domain/ports/citation-parser.port';
import { GrobidCitationParserAdapter } from './infrastructure/adapters/grobid-citation-parser.adapter';
import { PROJECT_ACCESS_PORT } from './domain/ports/project-access.port';
import { PrismaProjectAccessAdapter } from './infrastructure/adapters/prisma-project-access.adapter';

// ── 2. Collections ───────────────────────────────────────────────────────
import { CollectionsController } from './presentation/collections.controller';
import { CollectionsService } from './application/services/collections.service';
import { CollectionsRepository } from './infrastructure/repositories/collections.repository';
import { TreeEngine } from './application/engines/tree.engine';
import { COLLECTION_REPOSITORY_PORT } from './domain/ports/collection-repository.port';
import { PrismaCollectionRepositoryAdapter } from './infrastructure/adapters/prisma-collection-repository.adapter';
import { CreateCollectionUseCase } from './application/commands/create-collection.use-case';
import { ListCollectionsUseCase } from './application/queries/list-collections.use-case';
import { GetCollectionsUseCase } from './application/queries/get-collections.use-case';
import { GetCollectionTreeUseCase } from './application/queries/get-collection-tree.use-case';
import { GetCollectionByIdUseCase } from './application/queries/get-collection-by-id.use-case';
import { UpdateCollectionUseCase } from './application/commands/update-collection.use-case';
import { DeleteCollectionUseCase } from './application/commands/delete-collection.use-case';
import { ReorderCollectionsUseCase } from './application/commands/reorder-collections.use-case';
import { MoveItemsToCollectionUseCase } from './application/commands/move-items-to-collection.use-case';
import { AssignItemsToCollectionUseCase } from './application/commands/assign-items-to-collection.use-case';
import { DetachItemFromCollectionUseCase } from './application/commands/detach-item-from-collection.use-case';

// ── 3. Tags ──────────────────────────────────────────────────────────────
import { TagsController } from './presentation/tags.controller';
import { TagsRepository } from './infrastructure/repositories/tags.repository';
import { TagsService } from './application/services/tags.service';
import { TAG_REPOSITORY_PORT } from './domain/ports/tag-repository.port';
import { PrismaTagRepositoryAdapter } from './infrastructure/adapters/prisma-tag-repository.adapter';
import { CreateTagUseCase } from './application/commands/create-tag.use-case';
import { ListTagsUseCase } from './application/queries/list-tags.use-case';
import { DeleteTagUseCase } from './application/commands/delete-tag.use-case';
import { DeleteAutomaticTagsUseCase } from './application/commands/delete-automatic-tags.use-case';
import { AssignTagUseCase } from './application/commands/assign-tag.use-case';
import { DetachTagUseCase } from './application/commands/detach-tag.use-case';

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
  imports: [CoreModule, SharedKernelModule],
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
    BibliographyFacade,
    {
      provide: BIBLIOGRAPHY_FACADE,
      useExisting: BibliographyFacade,
    },
    {
      provide: CATALOG_FACADE,
      useExisting: BibliographyFacade,
    },

    // ── Items Providers ────────────────────────────────────────────────
    QueryRepository,
    CommandRepository,
    ItemsService,
    ItemSyncDelegate,
    ItemsMapper,
    ItemTransformer,
    {
      provide: ITEM_TRANSFORMER_PORT,
      useExisting: ItemTransformer,
    },
    {
      provide: FULLTEXT_QUERY_PORT,
      useExisting: QueryRepository,
    },
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
    PurgeItemUseCase,
    SetMyPublicationUseCase,
    ManageRelationsUseCase,
    PreviewTypeConversionUseCase,
    GrobidCitationParserAdapter,
    {
      provide: CITATION_PARSER_PORT,
      useClass: GrobidCitationParserAdapter,
    },
    PrismaProjectAccessAdapter,
    {
      provide: PROJECT_ACCESS_PORT,
      useClass: PrismaProjectAccessAdapter,
    },

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
    GetCollectionsUseCase,
    GetCollectionTreeUseCase,
    GetCollectionByIdUseCase,
    UpdateCollectionUseCase,
    DeleteCollectionUseCase,
    ReorderCollectionsUseCase,
    MoveItemsToCollectionUseCase,
    AssignItemsToCollectionUseCase,
    DetachItemFromCollectionUseCase,

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
    DeleteTagUseCase,
    DeleteAutomaticTagsUseCase,
    AssignTagUseCase,
    DetachTagUseCase,

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
    BibliographyFacade,
    BIBLIOGRAPHY_FACADE,
    CatalogFacade,
    CATALOG_FACADE,

    // Domain Ports
    ITEM_REPOSITORY_PORT,
    COLLECTION_REPOSITORY_PORT,
    TAG_REPOSITORY_PORT,
    ITEM_TRANSFORMER_PORT,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
  ],
})
export class BibliographyModule {}
