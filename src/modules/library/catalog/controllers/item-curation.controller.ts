import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ParseUUIDPipe,
  Optional,
  Inject,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { ParseCitationsDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemCurationService } from '@/modules/library/catalog/services/item-curation.service';
import { ItemFulltextService } from '@/modules/library/catalog/services/item-fulltext.service';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';
import {
  INGESTION_FACADE,
  IIngestionFacade,
  ReResolveMetadataOptions,
} from '@/modules/library/core';

/**
 * Shared Base Adapter for Library Item Curation & Scholarly Enrichment.
 * Directly communicates with domain-specialized services (Curation, Fulltext, TypeConversion)
 * to avoid indirect middleman delegation bottlenecks.
 */
export abstract class BaseItemCurationController {
  constructor(
    protected readonly itemService: ItemService,
    @Optional() protected readonly curationService?: ItemCurationService,
    @Optional() protected readonly fulltextService?: ItemFulltextService,
    @Optional()
    protected readonly typeConversionService?: ItemTypeConversionService,
    @Optional()
    @Inject(INGESTION_FACADE)
    protected readonly ingestionFacade?: IIngestionFacade,
  ) {}

  protected get curationRunner(): ItemCurationService | ItemService {
    return this.curationService ?? this.itemService;
  }

  protected get fulltextRunner(): ItemFulltextService | ItemService {
    return this.fulltextService ?? this.itemService;
  }

  protected get typeConversionRunner():
    ItemTypeConversionService | ItemService {
    return this.typeConversionService ?? this.itemService;
  }

  protected async executeReResolveMetadata(
    id: string,
    userId: string,
    body?: ReResolveMetadataOptions,
    projectId?: string,
  ) {
    if (!this.ingestionFacade || !this.ingestionFacade.reResolveMetadata) {
      throw new BadRequestException(
        'Ingestion service is not available for metadata re-resolution',
      );
    }
    return this.ingestionFacade.reResolveMetadata(userId, id, body, projectId);
  }

  protected async executeParseCitations(dto: ParseCitationsDto) {
    const rawCitations = dto.citations || dto.rawCitations || '';
    const references = await this.curationRunner.parseCitations(rawCitations);
    return {
      success: true,
      count: references.length,
      references,
      citations: references,
    };
  }

  protected async executeGetFulltext(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    const fulltext = await this.fulltextRunner.getFulltext(
      userId,
      id,
      projectId,
    );
    return { success: true, data: fulltext, ...fulltext };
  }

  protected async executeReindexItem(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    return this.itemService.reindexItem(userId, id, projectId);
  }

  protected async executePreviewTypeConversion(
    id: string,
    userId: string,
    body: {
      targetType?: string;
      targetItemType?: string;
      retainUnmappedInExtra?: boolean;
    },
    projectId?: string,
  ) {
    const item = await this.itemService.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const resolvedTargetType =
      body?.targetType || body?.targetItemType || 'journalArticle';
    const preview = this.typeConversionRunner.previewTypeConversion(
      item,
      resolvedTargetType,
      {
        retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
      },
    );
    return { success: true, preview, data: preview };
  }

  protected async executeConvertItemType(
    id: string,
    userId: string,
    ifMatch: string | undefined,
    body?: {
      targetType?: string;
      targetItemType?: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
    _projectId?: string,
  ) {
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;

    const resolvedTargetType =
      body?.targetType || body?.targetItemType || 'journalArticle';
    const result = await this.typeConversionRunner.convertItemType(
      userId,
      id,
      resolvedTargetType,
      {
        expectedVersion,
        retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
      },
    );

    return {
      success: true,
      data: result.item,
      item: result.item,
      conversionReport: result.conversionReport,
    };
  }

  protected async executeGetRelatedItems(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    return this.itemService.getRelatedItems(userId, id, projectId);
  }

  protected async executeLinkItems(
    id: string,
    body: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    userId: string,
    projectId?: string,
  ) {
    return this.itemService.linkItems(userId, id, body, projectId);
  }

  protected async executeUnlinkItems(
    id: string,
    targetItemId: string,
    userId: string,
    projectId?: string,
  ) {
    return this.itemService.unlinkItems(userId, id, targetItemId, projectId);
  }

  protected async executeMarkMyPublication(id: string, userId: string) {
    const item = await this.itemService.setMyPublication(userId, id, true);
    return { success: true, data: item, item };
  }

  protected async executeUnmarkMyPublication(id: string, userId: string) {
    const item = await this.itemService.setMyPublication(userId, id, false);
    return { success: true, data: item, item };
  }
}

/**
 * Personal Library Item Curation Controller (/api/v1/library/items, /api/v1/me/library/items).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Items - Personal Curation & Enrichment')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/items', 'api/v1/me/library/items'])
@UseGuards(JwtAuthGuard)
export class ItemCurationController extends BaseItemCurationController {
  constructor(
    itemService: ItemService,
    @Optional() curationService?: ItemCurationService,
    @Optional() fulltextService?: ItemFulltextService,
    @Optional() typeConversionService?: ItemTypeConversionService,
    @Optional()
    @Inject(INGESTION_FACADE)
    ingestionFacade?: IIngestionFacade,
  ) {
    super(
      itemService,
      curationService,
      fulltextService,
      typeConversionService,
      ingestionFacade,
    );
  }

  @Post(':id/re-resolve')
  @ApiOperation({
    summary:
      'Re-resolve metadata on demand for an item from Open Academic Mirrors',
  })
  async reResolveMetadata(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: ReResolveMetadataOptions,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || body?.projectId;
    return this.executeReResolveMetadata(id, userId, body, effectiveProjectId);
  }

  @Post('citations/parse')
  @ApiOperation({
    summary:
      'Parse raw unformatted citation strings via in-process citation parser',
  })
  async parseCitations(@Body() dto: ParseCitationsDto) {
    return this.executeParseCitations(dto);
  }

  @Get(':id/fulltext')
  @ApiOperation({ summary: 'Get fulltext of a personal item' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeGetFulltext(id, userId, projectId);
  }

  @Post(':id/reindex')
  @ApiOperation({ summary: 'Reindex a personal library item' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeReindexItem(id, userId, projectId);
  }

  @Post(':id/convert-type/preview')
  @ApiOperation({ summary: 'Preview type conversion of a personal item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      targetType?: string;
      targetItemType?: string;
      retainUnmappedInExtra?: boolean;
    },
    @Query('projectId') projectId?: string,
  ) {
    return this.executePreviewTypeConversion(id, userId, body, projectId);
  }

  @Post(':id/convert-type')
  @ApiOperation({ summary: 'Convert personal item type' })
  async convertItemType(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Body()
    body?: {
      targetType?: string;
      targetItemType?: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
    @Query('projectId') projectId?: string,
  ) {
    return this.executeConvertItemType(id, userId, ifMatch, body, projectId);
  }

  @Get(':id/relations')
  @ApiOperation({ summary: 'Get related items for personal item' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeGetRelatedItems(id, userId, projectId);
  }

  @Post([':id/relations', ':id/link'])
  @ApiOperation({ summary: 'Link personal items together' })
  async linkItems(
    @Param('id') id: string,
    @Body()
    body: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeLinkItems(id, body, userId, projectId);
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @ApiOperation({ summary: 'Unlink personal items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeUnlinkItems(id, targetItemId, userId, projectId);
  }

  @Post(':id/my-publication')
  @ApiOperation({ summary: 'Mark an item as my publication' })
  async markMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.executeMarkMyPublication(id, userId);
  }

  @Delete(':id/my-publication')
  @ApiOperation({ summary: 'Unmark an item as my publication' })
  async unmarkMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.executeUnmarkMyPublication(id, userId);
  }
}

/**
 * Project Library Item Curation Controller (/api/v1/projects/:projectId/library/items).
 * Strictly validates :projectId with ParseUUIDPipe and enforces project roles.
 */
@ApiTags('Library Items - Project Curation & Enrichment')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/items')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectItemCurationController extends BaseItemCurationController {
  constructor(
    itemService: ItemService,
    @Optional() curationService?: ItemCurationService,
    @Optional() fulltextService?: ItemFulltextService,
    @Optional() typeConversionService?: ItemTypeConversionService,
    @Optional()
    @Inject(INGESTION_FACADE)
    ingestionFacade?: IIngestionFacade,
  ) {
    super(
      itemService,
      curationService,
      fulltextService,
      typeConversionService,
      ingestionFacade,
    );
  }

  @Post(':id/re-resolve')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Re-resolve metadata on demand for a project item from Open Academic Mirrors',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async reResolveMetadata(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: ReResolveMetadataOptions,
  ) {
    return this.executeReResolveMetadata(id, userId, body, projectId);
  }

  @Post('citations/parse')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Parse raw unformatted citation strings via in-process citation parser',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async parseCitations(@Body() dto: ParseCitationsDto) {
    return this.executeParseCitations(dto);
  }

  @Get(':id/fulltext')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get fulltext of a project item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetFulltext(id, userId, projectId);
  }

  @Post(':id/reindex')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Reindex a project library item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeReindexItem(id, userId, projectId);
  }

  @Post(':id/convert-type/preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview type conversion of a project item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      targetType?: string;
      targetItemType?: string;
      retainUnmappedInExtra?: boolean;
    },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executePreviewTypeConversion(id, userId, body, projectId);
  }

  @Post(':id/convert-type')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Convert project item type' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async convertItemType(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Headers('if-match') ifMatch?: string,
    @Body()
    body?: {
      targetType?: string;
      targetItemType?: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
  ) {
    return this.executeConvertItemType(id, userId, ifMatch, body, projectId);
  }

  @Get(':id/relations')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get related items for project item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetRelatedItems(id, userId, projectId);
  }

  @Post([':id/relations', ':id/link'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Link project items together' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async linkItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body()
    body: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
  ) {
    return this.executeLinkItems(id, body, userId, projectId);
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unlink project items' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeUnlinkItems(id, targetItemId, userId, projectId);
  }
}
