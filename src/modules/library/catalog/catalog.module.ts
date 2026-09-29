import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';

// Controllers
import { ItemsController } from './items.controller';
import { CollectionsController } from './collections.controller';
import { TagsController } from './tags.controller';
import { TypesController } from './types.controller';
import { StateController, StateBatchController } from './state.controller';
import { SavedSearchesController } from './saved-searches.controller';
import { NotesController } from './notes.controller';

// Services
import { ItemsService } from './core/use-cases/items.service';
import { ItemSyncDelegate } from './core/use-cases/item-sync.delegate';
import { CollectionsService } from './core/use-cases/collections.service';
import { TagsService } from './core/use-cases/tags.service';
import { TypesService } from './core/use-cases/types.service';
import { StateService } from './core/use-cases/state.service';
import { SavedSearchesService } from './core/use-cases/saved-searches.service';
import { ZoteroSchemaValidatorService } from './core/use-cases/zotero-schema-validator.service';
import { NotesService } from './core/use-cases/notes.service';

// Search Indexing Gateway
import { SEARCH_INDEXING_PORT } from './core/ports/search-indexing.port';
import { InProcessSearchIndexingAdapter } from './core/adapters/in-process-search-indexing.adapter';

// Engines & Mappers
import { TreeEngine } from './core/adapters/tree.engine';
import { ConditionEvaluatorEngine } from './core/adapters/condition-evaluator.engine';
import { ItemsMapper } from './core/adapters/items.mapper';
import { ItemTransformer } from './core/adapters/item.transformer';

// Repositories
import { ItemCommandRepository } from './core/adapters/command.repository';
import { ItemQueryRepository } from './core/adapters/query.repository';
import { CollectionsRepository } from './core/adapters/collections.repository';
import { TagsRepository } from './core/adapters/tags.repository';
import { StateRepository } from './core/adapters/state.repository';
import { SavedSearchesRepository } from './core/adapters/saved-searches.repository';
import { NotesRepository } from './core/adapters/notes.repository';

// Ports & Adapters
import { ITEM_REPOSITORY_PORT } from './core/ports/item-repository.port';
import { PrismaItemRepositoryAdapter } from './core/adapters/prisma-item-repository.adapter';
import { COLLECTION_REPOSITORY_PORT } from './core/ports/collection-repository.port';
import { PrismaCollectionRepositoryAdapter } from './core/adapters/prisma-collection-repository.adapter';
import { TAG_REPOSITORY_PORT } from './core/ports/tag-repository.port';
import { PrismaTagRepositoryAdapter } from './core/adapters/prisma-tag-repository.adapter';
import { PROJECT_ACCESS_PORT } from './core/ports/project-access.port';
import { PrismaProjectAccessAdapter } from './core/adapters/prisma-project-access.adapter';
import { NOTE_REPOSITORY_PORT } from './core/ports/note-repository.port';
import { PrismaNoteRepositoryAdapter } from './core/adapters/prisma-note-repository.adapter';

import { ITEM_EXISTENCE_PORT, ITEM_READ_PORT } from './core/ports/items.ports';
import { ITEM_TRANSFORMER_PORT } from './core/ports/item-transformer.port';
import { FULLTEXT_QUERY_PORT } from './core/ports/fulltext-query.port';
import { CITATION_PARSER_PORT } from './core/ports/citation-parser.port';
import { GrobidCitationParserAdapter } from './core/adapters/grobid-citation-parser.adapter';

// Use Cases - Items
import { CreateItemUseCase } from './core/use-cases/create-item.use-case';
import { UpdateItemUseCase } from './core/use-cases/update-item.use-case';
import { DeleteItemUseCase } from './core/use-cases/delete-item.use-case';
import { RestoreItemUseCase } from './core/use-cases/restore-item.use-case';
import { PurgeItemUseCase } from './core/use-cases/purge-item.use-case';
import { ConvertItemTypeUseCase } from './core/use-cases/convert-item-type.use-case';
import { ImportItemsToProjectUseCase } from './core/use-cases/import-items-to-project.use-case';
import { SetMyPublicationUseCase } from './core/use-cases/set-my-publication.use-case';
import { ManageRelationsUseCase } from './core/use-cases/manage-relations.use-case';
import { ParseCitationsUseCase } from './core/use-cases/parse-citations.use-case';
import { ReindexItemUseCase } from './core/use-cases/reindex-item.use-case';
import { GetItemUseCase } from './core/use-cases/get-item.use-case';
import { ListItemsUseCase } from './core/use-cases/list-items.use-case';
import { GetFulltextUseCase } from './core/use-cases/get-fulltext.use-case';
import { PreviewTypeConversionUseCase } from './core/use-cases/preview-type-conversion.use-case';

// Use Cases - Collections
import { CreateCollectionUseCase } from './core/use-cases/create-collection.use-case';
import { ListCollectionsUseCase } from './core/use-cases/list-collections.use-case';
import { GetCollectionsUseCase } from './core/use-cases/get-collections.use-case';
import { GetCollectionTreeUseCase } from './core/use-cases/get-collection-tree.use-case';
import { GetCollectionByIdUseCase } from './core/use-cases/get-collection-by-id.use-case';
import { UpdateCollectionUseCase } from './core/use-cases/update-collection.use-case';
import { DeleteCollectionUseCase } from './core/use-cases/delete-collection.use-case';
import { ReorderCollectionsUseCase } from './core/use-cases/reorder-collections.use-case';
import { MoveItemsToCollectionUseCase } from './core/use-cases/move-items-to-collection.use-case';
import { AssignItemsToCollectionUseCase } from './core/use-cases/assign-items-to-collection.use-case';
import { DetachItemFromCollectionUseCase } from './core/use-cases/detach-item-from-collection.use-case';

// Use Cases - Tags
import { CreateTagUseCase } from './core/use-cases/create-tag.use-case';
import { ListTagsUseCase } from './core/use-cases/list-tags.use-case';
import { DeleteTagUseCase } from './core/use-cases/delete-tag.use-case';
import { DeleteAutomaticTagsUseCase } from './core/use-cases/delete-automatic-tags.use-case';
import { AssignTagUseCase } from './core/use-cases/assign-tag.use-case';
import { DetachTagUseCase } from './core/use-cases/detach-tag.use-case';

// Use Cases - Notes
import { CreateNoteUseCase } from './core/use-cases/create-note.use-case';
import { UpdateNoteUseCase } from './core/use-cases/update-note.use-case';
import { DeleteNoteUseCase } from './core/use-cases/delete-note.use-case';
import { ExtractNotesFromAnnotationsUseCase } from './core/use-cases/extract-notes-from-annotations.use-case';
import { GetNoteUseCase } from './core/use-cases/get-note.use-case';
import { ListNotesUseCase } from './core/use-cases/list-notes.use-case';

// Facade
import {
  CatalogFacade,
  CATALOG_FACADE,
  BibliographyFacade,
  BIBLIOGRAPHY_FACADE,
} from './catalog.facade';

/**
 * Dedicated Catalog Core Hexagonal Module.
 * Parity with Manuscripts Docstore / Overleaf Central Academic Metadata Architecture.
 *
 * Responsibilities:
 * - 37 Zotero/CSL Item Entities & Schema Validation
 * - Optimistic Concurrency Control (OCC versioning)
 * - Hierarchical Collections & Smart Folders
 * - Tag Management & Scientific Taxonomies
 * - Item Read State & Saved Search Queries
 * - Scholarly Markdown Research Notes
 */
@Module({
  imports: [CoreModule, SyncModule],
  controllers: [
    ItemsController,
    CollectionsController,
    TagsController,
    TypesController,
    StateController,
    StateBatchController,
    SavedSearchesController,
    NotesController,
  ],
  providers: [
    // Facades
    CatalogFacade,
    {
      provide: CATALOG_FACADE,
      useExisting: CatalogFacade,
    },
    {
      provide: BIBLIOGRAPHY_FACADE,
      useExisting: CatalogFacade,
    },

    // Search Indexing Gateway
    InProcessSearchIndexingAdapter,
    {
      provide: SEARCH_INDEXING_PORT,
      useClass: InProcessSearchIndexingAdapter,
    },

    // Services
    ItemsService,
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
    ItemCommandRepository,
    ItemQueryRepository,
    {
      provide: FULLTEXT_QUERY_PORT,
      useExisting: ItemQueryRepository,
    },
    {
      provide: ITEM_EXISTENCE_PORT,
      useExisting: ItemsService,
    },
    {
      provide: ITEM_READ_PORT,
      useExisting: ItemsService,
    },
    CollectionsRepository,
    TagsRepository,
    StateRepository,
    SavedSearchesRepository,
    NotesRepository,

    // Ports & Adapters
    PrismaItemRepositoryAdapter,
    {
      provide: ITEM_REPOSITORY_PORT,
      useClass: PrismaItemRepositoryAdapter,
    },
    PrismaCollectionRepositoryAdapter,
    {
      provide: COLLECTION_REPOSITORY_PORT,
      useClass: PrismaCollectionRepositoryAdapter,
    },
    PrismaTagRepositoryAdapter,
    {
      provide: TAG_REPOSITORY_PORT,
      useClass: PrismaTagRepositoryAdapter,
    },
    PrismaProjectAccessAdapter,
    {
      provide: PROJECT_ACCESS_PORT,
      useClass: PrismaProjectAccessAdapter,
    },
    PrismaNoteRepositoryAdapter,
    {
      provide: NOTE_REPOSITORY_PORT,
      useClass: PrismaNoteRepositoryAdapter,
    },
    GrobidCitationParserAdapter,
    {
      provide: CITATION_PARSER_PORT,
      useClass: GrobidCitationParserAdapter,
    },

    // Use cases - Items
    CreateItemUseCase,
    UpdateItemUseCase,
    DeleteItemUseCase,
    RestoreItemUseCase,
    PurgeItemUseCase,
    ConvertItemTypeUseCase,
    ImportItemsToProjectUseCase,
    SetMyPublicationUseCase,
    ManageRelationsUseCase,
    ParseCitationsUseCase,
    ReindexItemUseCase,
    GetItemUseCase,
    ListItemsUseCase,
    GetFulltextUseCase,
    PreviewTypeConversionUseCase,

    // Use cases - Collections
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

    // Use cases - Tags
    CreateTagUseCase,
    ListTagsUseCase,
    DeleteTagUseCase,
    DeleteAutomaticTagsUseCase,
    AssignTagUseCase,
    DetachTagUseCase,

    // Use cases - Notes
    CreateNoteUseCase,
    UpdateNoteUseCase,
    DeleteNoteUseCase,
    ExtractNotesFromAnnotationsUseCase,
    GetNoteUseCase,
    ListNotesUseCase,
  ],
  exports: [
    CatalogFacade,
    CATALOG_FACADE,
    BIBLIOGRAPHY_FACADE,
    ItemsService,
    ItemSyncDelegate,
    CollectionsService,
    TagsService,
    TypesService,
    StateService,
    SavedSearchesService,
    NotesService,
    TreeEngine,
    ConditionEvaluatorEngine,
    ITEM_REPOSITORY_PORT,
    COLLECTION_REPOSITORY_PORT,
    TAG_REPOSITORY_PORT,
    PROJECT_ACCESS_PORT,
    NOTE_REPOSITORY_PORT,
    ITEM_TRANSFORMER_PORT,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
    GetItemUseCase,
    ListItemsUseCase,
  ],
})
export class CatalogModule {}
