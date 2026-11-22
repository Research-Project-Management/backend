import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseEnumPipe,
  Headers,
  NotFoundException,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { CollectionDeleteStrategy } from '@/modules/library/catalog/types/catalog.types';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import {
  normalizeProjectSpaceId,
  INGESTION_FACADE,
  IIngestionFacade,
} from '@/modules/library/core';
import {
  ParseCitationsDto,
  ReResolveMetadataDto,
  TypeConversionPreviewDto,
  TypeConversionDto,
  LinkItemsDto,
  MarkMyPublicationDto,
} from '@/modules/library/catalog/dto/items.dto';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemCurationService } from '@/modules/library/catalog/services/curation.service';
import {
  ItemFulltextService,
  ItemRelationsService,
} from '@/modules/library/catalog/services/relations.service';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/type-conversion.service';


@ApiTags('Library Items - Curation & Enrichment')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/items', 'api/v1/spaces/:spaceId/library/items'])
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    if (!this.ingestionFacade || !this.ingestionFacade.reResolveMetadata) {
      throw new BadRequestException(
        'Ingestion service is not available for metadata re-resolution',
      );
    }
    const effectiveProjectId = normalizeProjectSpaceId(
      paramProjectId || queryProjectId || body?.spaceId,
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
    @Query('attachmentId') attachmentId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.itemService.reindexItem(userId, id, projectId);
  }

  @Post(':id/convert-type/preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview type conversion of an item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: TypeConversionPreviewDto,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;

    const resolvedTargetType =
      body?.targetType || body?.targetItemType || 'journalArticle';
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.relationsService.getRelatedItems(userId, id, projectId);
  }

  @Post(':id/relations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Link items together' })
  async linkItems(
    @Param('id') id: string,
    @Body() body: LinkItemsDto,
    @CurrentUser('id') userId: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    return this.relationsService.linkItems(userId, id, body, projectId);
  }

  @Delete(':id/relations/:targetId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unlink items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(
      paramProjectId || queryProjectId || body?.spaceId,
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
    @Query('spaceId') queryProjectId?: string,
    @Param('spaceId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectSpaceId(paramProjectId || queryProjectId);
    const item = projectId
      ? await this.itemService.setMyPublication(userId, id, false, {
          projectId,
        })
      : await this.itemService.setMyPublication(userId, id, false);
    return { success: true, data: item, item };
  }
}
