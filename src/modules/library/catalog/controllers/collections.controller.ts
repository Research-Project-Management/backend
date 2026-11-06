import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus, ParseEnumPipe, Headers, NotFoundException, BadRequestException, Optional, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { CreateCollectionDto, UpdateCollectionDto, MoveItemsDto, ReorderCollectionsDto, AssignItemsToCollectionDto, BulkDetachItemsDto, CopyCollectionDto } from '@/modules/library/catalog/dto/collections.dto';
import { CollectionDeleteStrategy } from '@/modules/library/catalog/types/catalog.types';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId, INGESTION_FACADE, IIngestionFacade } from '@/modules/library/core';
import { ParseCitationsDto, ReResolveMetadataDto, TypeConversionPreviewDto, TypeConversionDto, LinkItemsDto, MarkMyPublicationDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemCurationService } from '@/modules/library/catalog/services/item-curation.service';
import { ItemFulltextService, ItemRelationsService } from '@/modules/library/catalog/services/item-relations.service';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/collections',
  'api/v1/projects/:projectId/library/collections',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class CollectionsController {
  constructor(protected readonly collectionsService: CollectionsService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'List all collections in personal or project scope',
  })
  async getCollections(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.getCollections(userId, projectId);
  }

  @Get('tree')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get collection tree in personal or project scope' })
  async getCollectionTree(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.getCollectionTree(userId, projectId);
  }

  @Patch('reorder')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder collections' })
  async reorderCollections(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderCollectionsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.reorderCollections(
      userId,
      dto.collections,
      projectId,
    );
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create collection' })
  async createCollection(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    return this.collectionsService.createCollection(userId, dto, projectId);
  }

  @Get(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get collection by ID' })
  async getCollectionById(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.getCollectionById(
      userId,
      collectionId,
      projectId,
    );
  }

  @Put(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update collection' })
  async updateCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.updateCollection(
      userId,
      collectionId,
      dto,
      projectId,
    );
  }

  @Delete(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete collection' })
  async deleteCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy', new ParseEnumPipe(CollectionDeleteStrategy, { optional: true }))
    strategy?: CollectionDeleteStrategy,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.deleteCollection(
      userId,
      collectionId,
      strategy,
      projectId,
    );
  }

  @Post(':collectionId/move-items')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move items to collection' })
  async moveItems(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.moveItems(
      userId,
      collectionId,
      dto.itemIds || [],
      projectId,
      dto.sourceCollectionId,
    );
  }

  @Post(':collectionId/items')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign items to collection' })
  async assignItemsToCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.assignItemsToCollection(
      userId,
      collectionId,
      dto,
      projectId,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Detach item from collection' })
  async detachItemFromCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.detachItemFromCollection(
      userId,
      collectionId,
      itemId,
      projectId,
    );
  }

  @Post(':collectionId/items/bulk-detach')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Detach multiple items from collection in batch' })
  async bulkDetachItems(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: BulkDetachItemsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.collectionsService.detachItemsFromCollection(
      userId,
      collectionId,
      dto?.itemIds || [],
      projectId,
    );
  }

  @Post(':collectionId/copy')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Atomically duplicate collection subtree and item memberships' })
  async copyCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto?: CopyCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    return this.collectionsService.copyCollection(
      userId,
      collectionId,
      dto,
      projectId,
    );
  }
}

@ApiTags('Library Items - Curation & Enrichment')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items',
  'api/v1/projects/:projectId/library/items',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ItemCurationController {
  constructor(
    protected readonly itemService: ItemService,
    protected readonly curationService: ItemCurationService,
    protected readonly fulltextService: ItemFulltextService,
    protected readonly typeConversionService: ItemTypeConversionService,
    @Optional()
    @Inject(INGESTION_FACADE)
    protected readonly ingestionFacade: IIngestionFacade | undefined,
    protected readonly relationsService: ItemRelationsService,
  ) {}

  @Post(':id/re-resolve')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Re-resolve metadata on demand for an item from Open Academic Mirrors',
  })
  async reResolveMetadata(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: ReResolveMetadataDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!this.ingestionFacade || !this.ingestionFacade.reResolveMetadata) {
      throw new BadRequestException(
        'Ingestion service is not available for metadata re-resolution',
      );
    }
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || body?.projectId,
    );
    return this.ingestionFacade.reResolveMetadata(
      userId,
      id,
      body,
      effectiveProjectId,
    );
  }

  @Post('citations/parse')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Parse raw unformatted citation strings via in-process citation parser',
  })
  async parseCitations(@Body() dto: ParseCitationsDto) {
    const rawCitations = dto.citations || dto.rawCitations || '';
    const references = await this.curationService.parseCitations(rawCitations);
    return {
      success: true,
      count: references.length,
      references,
      citations: references,
    };
  }

  @Get(':id/fulltext')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get fulltext of an item' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
    @Query('attachmentId') attachmentId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const fulltext = attachmentId
      ? await this.fulltextService.getFulltext(
          userId,
          id,
          projectId,
          attachmentId,
        )
      : await this.fulltextService.getFulltext(userId, id, projectId);
    const response = { success: true, ...fulltext } as typeof fulltext & {
      success: boolean;
      data: typeof fulltext;
    };
    Object.defineProperty(response, 'data', {
      value: fulltext,
      enumerable: false,
      configurable: true,
    });
    return response;
  }

  @Post(':id/reindex')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Reindex a library item' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.itemService.reindexItem(userId, id, projectId);
  }

  @Post(':id/convert-type/preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview type conversion of an item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: TypeConversionPreviewDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const item = await this.itemService.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const resolvedTargetType =
      body?.targetType || body?.targetItemType || 'journalArticle';
    const preview = this.typeConversionService.previewTypeConversion(
      item,
      resolvedTargetType,
      {
        retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
      },
    );
    return { success: true, preview, data: preview };
  }

  @Post(':id/convert-type')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Convert item type' })
  async convertItemType(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Body() body?: TypeConversionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;

    const resolvedTargetType =
      body?.targetType || body?.targetItemType || 'journalArticle';
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const result = await this.typeConversionService.convertItemType(
      userId,
      id,
      resolvedTargetType,
      {
        expectedVersion,
        retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
      },
      projectId,
    );

    return {
      success: true,
      data: result.item,
      item: result.item,
      conversionReport: result.conversionReport,
    };
  }

  @Get(':id/relations')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get related items' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.relationsService.getRelatedItems(userId, id, projectId);
  }

  @Post(':id/relations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Link items together' })
  async linkItems(
    @Param('id') id: string,
    @Body() body: LinkItemsDto,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.relationsService.linkItems(userId, id, body, projectId);
  }

  @Delete(':id/relations/:targetId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unlink items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.relationsService.unlinkItems(
      userId,
      id,
      targetItemId,
      projectId,
    );
  }

  @Post(':id/my-publication')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Mark an item as my publication' })
  async markMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body?: MarkMyPublicationDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || body?.projectId,
    );
    const options = {
      ...(body || {}),
      ...(projectId ? { projectId } : {}),
    };
    const item =
      Object.keys(options).length > 0
        ? await this.itemService.setMyPublication(userId, id, true, options)
        : await this.itemService.setMyPublication(userId, id, true);
    return { success: true, data: item, item };
  }

  @Delete(':id/my-publication')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unmark an item as my publication' })
  async unmarkMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const item = projectId
      ? await this.itemService.setMyPublication(userId, id, false, {
          projectId,
        })
      : await this.itemService.setMyPublication(userId, id, false);
    return { success: true, data: item, item };
  }
}
