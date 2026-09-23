import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Optional,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { isUUID } from 'class-validator';
import {
  CursorPaginationQueryDto,
  CreateItemDto,
  UpdateItemDto,
  ParseCitationsDto,
} from '../application/dtos/items.dto';
import { CreateItemUseCase } from '../application/commands/create-item.use-case';
import { UpdateItemUseCase } from '../application/commands/update-item.use-case';
import { DeleteItemUseCase } from '../application/commands/delete-item.use-case';
import { RestoreItemUseCase } from '../application/commands/restore-item.use-case';
import { GetItemUseCase } from '../application/queries/get-item.use-case';
import { ListItemsUseCase } from '../application/queries/list-items.use-case';
// A1 — New Use Cases
import { GetFulltextUseCase } from '../application/queries/get-fulltext.use-case';
import { ParseCitationsUseCase } from '../application/commands/parse-citations.use-case';
import { ReindexItemUseCase } from '../application/commands/reindex-item.use-case';
import { ConvertItemTypeUseCase } from '../application/commands/convert-item-type.use-case';
import {
  CatalogDomainException,
  ItemNotFoundDomainException,
  ItemConcurrencyDomainException,
} from '../domain/exceptions/item-domain.exception';
import { VersionMismatchException } from '../../shared-kernel/core/errors/version-mismatch.exception';

import { ImportItemsToProjectUseCase } from '../application/commands/import-items-to-project.use-case';
import { PurgeItemUseCase } from '../application/commands/purge-item.use-case';
import { SetMyPublicationUseCase } from '../application/commands/set-my-publication.use-case';
import { ManageRelationsUseCase } from '../application/commands/manage-relations.use-case';
import { PreviewTypeConversionUseCase } from '../application/queries/preview-type-conversion.use-case';
import { ItemsService } from '../application/services/items.service';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@ApiTags('Library Items')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items',
  'api/v1/me/library/items',
  'api/v1/projects/:projectId/library/items',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ItemsController {
  constructor(
    private readonly createItemUseCase: CreateItemUseCase,
    private readonly updateItemUseCase: UpdateItemUseCase,
    private readonly deleteItemUseCase: DeleteItemUseCase,
    private readonly restoreItemUseCase: RestoreItemUseCase,
    private readonly getItemUseCase: GetItemUseCase,
    private readonly listItemsUseCase: ListItemsUseCase,
    private readonly getFulltextUseCase: GetFulltextUseCase,
    private readonly parseCitationsUseCase: ParseCitationsUseCase,
    private readonly reindexItemUseCase: ReindexItemUseCase,
    private readonly convertItemTypeUseCase: ConvertItemTypeUseCase,
    private readonly importItemsToProjectUseCase: ImportItemsToProjectUseCase,
    private readonly purgeItemUseCase: PurgeItemUseCase,
    private readonly setMyPublicationUseCase: SetMyPublicationUseCase,
    private readonly manageRelationsUseCase: ManageRelationsUseCase,
    private readonly previewTypeConversionUseCase: PreviewTypeConversionUseCase,
    @Optional() private readonly itemsService?: ItemsService,
  ) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List library items' })
  async listItems(
    @CurrentUser('id') userId: string,
    @Query()
    query?: CursorPaginationQueryDto & {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications';
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
    @Param('projectId') projectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      projectId || (query as any)?.projectId,
    );
    const result = await this.listItemsUseCase.execute({
      userId,
      view: query?.view,
      collectionId: query?.collectionId,
      tagId: query?.tagId,
      search: query?.search,
      cursor: query?.cursor,
      limit: query?.limit,
      orderBy: query?.orderBy,
      orderDirection: query?.orderDirection,
      itemType: query?.itemType || query?.type,
      fromYear: query?.fromYear,
      toYear: query?.toYear,
      readStatus: query?.readStatus,
      hasFile: query?.hasFile,
      projectId: effectiveProjectId,
    });
    return { items: result.items, pagination: result.pagination };
  }

  @Post('import')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Import items from personal library into project' })
  async importItems(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string | undefined,
    @Body() body: { itemIds: string[] },
  ) {
    if (!projectId) {
      throw new BadRequestException(
        'Project ID is required in URL parameter to import items',
      );
    }
    return this.importItemsToProjectUseCase.execute({
      userId,
      projectId,
      itemIds: body.itemIds || [],
    });
  }

  @Post('citations/parse')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Parse raw unformatted citation strings via GROBID CRF model',
    description:
      'Extracts structured title, authors, venue, year, volume, and DOI from unstructured raw text strings without needing a PDF file.',
  })
  async parseCitations(@Body() dto: ParseCitationsDto) {
    const result = await this.parseCitationsUseCase.execute({
      rawCitations: dto.citations,
    });
    return {
      success: true,
      count: result.count,
      data: result.references,
    };
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a library item by ID' })
  async getItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const item = await this.getItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    return item;
  }

  @Get(':id/fulltext')
  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=3600')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get fulltext of an item' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    const fulltext = await this.getFulltextUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    return { success: true, data: fulltext, ...fulltext };
  }

  @Get(':id/metadata-sources')
  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=3600')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get raw provenance metadata sources for an item',
    description:
      'Fetches all raw academic metadata payloads (arXiv, GROBID, CrossRef) previously resolved and saved for this item.',
  })
  async getMetadataSources(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    if (this.itemsService) {
      return this.itemsService.getMetadataSources(
        userId,
        id,
        toValidProjectId(projectId),
      );
    }
    return { itemId: id, count: 0, sources: [] };
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a new library item' })
  async createItem(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string | undefined,
    @Body() body: CreateItemDto,
    @Headers('x-idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const { crossrefEnriched: _cr, ...cleanBody } = body;
    const effectiveProjectId = toValidProjectId(
      projectId || cleanBody.projectId,
    );

    const {
      title,
      itemType,
      type,
      doi,
      citationKey,
      abstract,
      abstractNote,
      year,
      publicationTitle,
      extra,
      ...otherFields
    } = cleanBody as any;

    const parsedExtra = extra
      ? typeof extra === 'string' && extra.trim().startsWith('{')
        ? (() => {
            try {
              return JSON.parse(extra);
            } catch {
              return { extra };
            }
          })()
        : { extra }
      : {};

    const combinedFields = {
      ...otherFields,
      ...parsedExtra,
    };

    try {
      return await this.createItemUseCase.execute({
        userId,
        projectId: effectiveProjectId,
        title: title || 'Untitled',
        itemType: itemType || type || 'journalArticle',
        doi,
        citationKey,
        abstract: abstract || abstractNote,
        year,
        publicationTitle,
        fields: combinedFields,
        idempotencyKey,
        correlationId,
      });
    } catch (err: any) {
      if (err instanceof CatalogDomainException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a library item' })
  async updateItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
    @Param('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const parsedHeaderVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const expectedVersion =
      body.expectedVersion !== undefined
        ? Number(body.expectedVersion)
        : parsedHeaderVersion !== undefined && !isNaN(parsedHeaderVersion)
          ? parsedHeaderVersion
          : undefined;
    if (
      expectedVersion !== undefined &&
      (isNaN(expectedVersion) || expectedVersion < 0)
    ) {
      throw new BadRequestException(
        'Invalid expectedVersion specified',
      );
    }
    const { expectedVersion: _, crossrefEnriched: _cr, ...updateData } = body;
    try {
      return await this.updateItemUseCase.execute({
        userId,
        itemId: id,
        expectedVersion,
        changes: updateData,
        projectId: toValidProjectId(projectId),
        correlationId,
      });
    } catch (err: any) {
      if (err instanceof ItemConcurrencyDomainException) {
        throw new VersionMismatchException(
          err.itemId,
          err.currentVersion,
          err.expectedVersion,
        );
      }
      if (err instanceof ItemNotFoundDomainException) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof CatalogDomainException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Put(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Replace a library item' })
  async replaceItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.updateItem(id, userId, ifMatch, body, projectId);
  }

  @Post(':id/reindex')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Reindex a library item' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.reindexItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
  }

  @Post(':id/convert-type/preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview type conversion of an item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
    @Param('projectId') projectId?: string,
  ) {
    const item = await this.getItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const preview = this.previewTypeConversionUseCase.execute({
      item,
      targetType: body.targetType,
      options: {
        retainUnmappedInExtra: body.retainUnmappedInExtra ?? true,
      },
    });
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
      targetType: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
    @Param('projectId') projectId?: string,
  ) {
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    const result = await this.convertItemTypeUseCase.execute({
      userId,
      itemId: id,
      targetType: body?.targetType || 'journalArticle',
      options: {
        expectedVersion,
        retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
      },
    });

    return {
      success: true,
      data: result.item,
      item: result.item,
      conversionReport: result.conversionReport,
    };
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete an item (soft delete)' })
  async deleteItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Param('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException('Invalid item ID format');
    }
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;

    try {
      await this.deleteItemUseCase.execute({
        userId,
        itemId: id,
        expectedVersion,
        projectId: toValidProjectId(projectId),
        correlationId,
      });
      return { success: true, deleted: true, id };
    } catch (err: any) {
      if (err instanceof ItemNotFoundDomainException) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof ItemConcurrencyDomainException) {
        throw new VersionMismatchException(
          err.itemId,
          err.currentVersion,
          err.expectedVersion,
        );
      }
      throw err;
    }
  }

  @Post(':id/restore')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore a deleted item' })
  async restoreItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Param('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Trashed item ${id} not found`);
    }
    const expectedVersion =
      expectedVersionQuery !== undefined
        ? parseInt(expectedVersionQuery, 10)
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;

    try {
      const restored = await this.restoreItemUseCase.execute({
        userId,
        itemId: id,
        expectedVersion,
        projectId: toValidProjectId(projectId),
        correlationId,
      });
      return { success: true, data: restored, item: restored };
    } catch (err: any) {
      if (err instanceof ItemNotFoundDomainException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Delete(':id/purge')
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Permanently purge a deleted item' })
  async purgeItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    const purged = await this.purgeItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    return { success: true, purged, id };
  }

  @Get(':id/relations')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get related items' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.manageRelationsUseCase.getRelatedItems(
      userId,
      id,
      toValidProjectId(projectId),
    );
  }

  @Post([':id/relations', ':id/link'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Link two or more items together' })
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
    @Param('projectId') projectId?: string,
  ) {
    return this.manageRelationsUseCase.linkItems({
      userId,
      sourceItemId: id,
      data: body,
      projectId: toValidProjectId(projectId),
    });
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unlink items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.manageRelationsUseCase.unlinkItems({
      userId,
      sourceItemId: id,
      targetItemId,
      projectId: toValidProjectId(projectId),
    });
  }

  @Post(':id/my-publication')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Mark an item as my publication' })
  async markMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const item = await this.setMyPublicationUseCase.execute({
      userId,
      itemId: id,
      isMyPublication: true,
    });
    return { success: true, data: item, item };
  }

  @Delete(':id/my-publication')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unmark an item as my publication' })
  async unmarkMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const item = await this.setMyPublicationUseCase.execute({
      userId,
      itemId: id,
      isMyPublication: false,
    });
    return { success: true, data: item, item };
  }
}
