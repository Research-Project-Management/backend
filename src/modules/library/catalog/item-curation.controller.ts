import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { isUUID } from 'class-validator';
import { ParseCitationsDto } from './dto/items.dto';
import { GetFulltextUseCase } from './core/use-cases/get-fulltext.use-case';
import { ParseCitationsUseCase } from './core/use-cases/parse-citations.use-case';
import { ReindexItemUseCase } from './core/use-cases/reindex-item.use-case';
import { ConvertItemTypeUseCase } from './core/use-cases/convert-item-type.use-case';
import { PreviewTypeConversionUseCase } from './core/use-cases/preview-type-conversion.use-case';
import { ManageRelationsUseCase } from './core/use-cases/manage-relations.use-case';
import { SetMyPublicationUseCase } from './core/use-cases/set-my-publication.use-case';
import { GetItemUseCase } from './core/use-cases/get-item.use-case';
import {
  CatalogDomainException,
  ItemConcurrencyDomainException,
} from './core/domain/item-domain.exception';
import { VersionMismatchException } from '../shared-kernel/core/errors/version-mismatch.exception';

/**
 * Shared Base Adapter for Library Item Curation & Scholarly Enrichment.
 */
export abstract class BaseItemCurationController {
  constructor(
    protected readonly getFulltextUseCase: GetFulltextUseCase,
    protected readonly parseCitationsUseCase: ParseCitationsUseCase,
    protected readonly reindexItemUseCase: ReindexItemUseCase,
    protected readonly convertItemTypeUseCase: ConvertItemTypeUseCase,
    protected readonly previewTypeConversionUseCase: PreviewTypeConversionUseCase,
    protected readonly manageRelationsUseCase: ManageRelationsUseCase,
    protected readonly setMyPublicationUseCase: SetMyPublicationUseCase,
    protected readonly getItemUseCase: GetItemUseCase,
  ) {}

  protected async executeParseCitations(dto: ParseCitationsDto) {
    const rawCitations = (dto as any).citations || (dto as any).rawCitations;
    const parsed = await this.parseCitationsUseCase.execute({
      rawCitations,
    });
    return {
      success: true,
      count: parsed.count,
      references: parsed.references,
      citations: parsed.references,
    };
  }

  protected async executeGetFulltext(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    const fulltext = await this.getFulltextUseCase.execute({
      userId,
      itemId: id,
      projectId,
    });
    return { success: true, data: fulltext, ...fulltext };
  }

  protected async executeReindexItem(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    return this.reindexItemUseCase.execute({
      userId,
      itemId: id,
      projectId,
    });
  }

  protected async executePreviewTypeConversion(
    id: string,
    userId: string,
    body: { targetType: string; retainUnmappedInExtra?: boolean },
    projectId?: string,
  ) {
    const item = await this.getItemUseCase.execute({
      userId,
      itemId: id,
      projectId,
    });
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    try {
      const preview = this.previewTypeConversionUseCase.execute({
        item,
        targetType: body.targetType,
        options: {
          retainUnmappedInExtra: body.retainUnmappedInExtra ?? true,
        },
      });
      return { success: true, preview, data: preview };
    } catch (err: any) {
      if (err instanceof CatalogDomainException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  protected async executeConvertItemType(
    id: string,
    userId: string,
    ifMatch: string | undefined,
    body?: {
      targetType: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
    projectId?: string,
  ) {
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    try {
      const result = await this.convertItemTypeUseCase.execute({
        userId,
        itemId: id,
        targetType: body?.targetType || 'journalArticle',
        options: {
          expectedVersion,
          retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
        },
        projectId,
      });

      return {
        success: true,
        data: result.item,
        item: result.item,
        conversionReport: result.conversionReport,
      };
    } catch (err: any) {
      if (err instanceof ItemConcurrencyDomainException) {
        throw new VersionMismatchException(
          err.itemId,
          err.currentVersion,
          err.expectedVersion,
        );
      }
      if (err instanceof CatalogDomainException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  protected async executeGetRelatedItems(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    return this.manageRelationsUseCase.getRelatedItems(userId, id, projectId);
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
    return this.manageRelationsUseCase.linkItems({
      userId,
      sourceItemId: id,
      data: body,
      projectId,
    });
  }

  protected async executeUnlinkItems(
    id: string,
    targetItemId: string,
    userId: string,
    projectId?: string,
  ) {
    return this.manageRelationsUseCase.unlinkItems({
      userId,
      sourceItemId: id,
      targetItemId,
      projectId,
    });
  }

  protected async executeMarkMyPublication(id: string, userId: string) {
    const item = await this.setMyPublicationUseCase.execute({
      userId,
      itemId: id,
      isMyPublication: true,
    });
    return { success: true, data: item, item };
  }

  protected async executeUnmarkMyPublication(id: string, userId: string) {
    const item = await this.setMyPublicationUseCase.execute({
      userId,
      itemId: id,
      isMyPublication: false,
    });
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
    getFulltextUseCase: GetFulltextUseCase,
    parseCitationsUseCase: ParseCitationsUseCase,
    reindexItemUseCase: ReindexItemUseCase,
    convertItemTypeUseCase: ConvertItemTypeUseCase,
    previewTypeConversionUseCase: PreviewTypeConversionUseCase,
    manageRelationsUseCase: ManageRelationsUseCase,
    setMyPublicationUseCase: SetMyPublicationUseCase,
    getItemUseCase: GetItemUseCase,
  ) {
    super(
      getFulltextUseCase,
      parseCitationsUseCase,
      reindexItemUseCase,
      convertItemTypeUseCase,
      previewTypeConversionUseCase,
      manageRelationsUseCase,
      setMyPublicationUseCase,
      getItemUseCase,
    );
  }

  @Post('citations/parse')
  @ApiOperation({
    summary: 'Parse raw unformatted citation strings via GROBID CRF model',
  })
  async parseCitations(@Body() dto: ParseCitationsDto) {
    return this.executeParseCitations(dto);
  }

  @Get(':id/fulltext')
  @ApiOperation({ summary: 'Get fulltext of a personal item' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    projectId?: string,
  ) {
    return this.executeGetFulltext(id, userId, projectId);
  }

  @Post(':id/reindex')
  @ApiOperation({ summary: 'Reindex a personal library item' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    projectId?: string,
  ) {
    return this.executeReindexItem(id, userId, projectId);
  }

  @Post(':id/convert-type/preview')
  @ApiOperation({ summary: 'Preview type conversion of a personal item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
    projectId?: string,
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
      targetType: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
    projectId?: string,
  ) {
    return this.executeConvertItemType(id, userId, ifMatch, body, projectId);
  }

  @Get(':id/relations')
  @ApiOperation({ summary: 'Get related items for personal item' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    projectId?: string,
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
    projectId?: string,
  ) {
    return this.executeLinkItems(id, body, userId, projectId);
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @ApiOperation({ summary: 'Unlink personal items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    projectId?: string,
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
    getFulltextUseCase: GetFulltextUseCase,
    parseCitationsUseCase: ParseCitationsUseCase,
    reindexItemUseCase: ReindexItemUseCase,
    convertItemTypeUseCase: ConvertItemTypeUseCase,
    previewTypeConversionUseCase: PreviewTypeConversionUseCase,
    manageRelationsUseCase: ManageRelationsUseCase,
    setMyPublicationUseCase: SetMyPublicationUseCase,
    getItemUseCase: GetItemUseCase,
  ) {
    super(
      getFulltextUseCase,
      parseCitationsUseCase,
      reindexItemUseCase,
      convertItemTypeUseCase,
      previewTypeConversionUseCase,
      manageRelationsUseCase,
      setMyPublicationUseCase,
      getItemUseCase,
    );
  }

  @Post('citations/parse')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Parse raw unformatted citation strings via GROBID CRF model',
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
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
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
      targetType: string;
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
