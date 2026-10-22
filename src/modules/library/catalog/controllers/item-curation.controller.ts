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
  Optional,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { ParseCitationsDto } from '@/modules/library/catalog/dto/items.dto';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemCurationService } from '@/modules/library/catalog/services/item-curation.service';
import { ItemFulltextService } from '@/modules/library/catalog/services/item-fulltext.service';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';
import { ItemRelationsService } from '@/modules/library/catalog/services/item-relations.service';
import {
  INGESTION_FACADE,
  IIngestionFacade,
  ReResolveMetadataOptions,
  normalizeProjectScopeId,
} from '@/modules/library/core';

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
    @Body() body: ReResolveMetadataOptions,
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
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const fulltext = await this.fulltextService.getFulltext(
      userId,
      id,
      projectId,
    );
    return { success: true, data: fulltext, ...fulltext };
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
    @Body()
    body: {
      targetType?: string;
      targetItemType?: string;
      retainUnmappedInExtra?: boolean;
    },
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
    @Body()
    body?: {
      targetType?: string;
      targetItemType?: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
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
    @Body()
    body: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
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
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const item = projectId
      ? await this.itemService.setMyPublication(userId, id, true, { projectId })
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
      ? await this.itemService.setMyPublication(userId, id, false, { projectId })
      : await this.itemService.setMyPublication(userId, id, false);
    return { success: true, data: item, item };
  }
}
