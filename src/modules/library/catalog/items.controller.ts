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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { isUUID } from 'class-validator';
import {
  CursorPaginationQueryDto,
  CreateItemDto,
  UpdateItemDto,
  BulkPurgeItemsDto,
} from './dto/items.dto';
import { ItemsService } from './core/services/items.service';
import { CreateItemUseCase } from './core/use-cases/create-item.use-case';
import { UpdateItemUseCase } from './core/use-cases/update-item.use-case';
import { DeleteItemUseCase } from './core/use-cases/delete-item.use-case';
import { RestoreItemUseCase } from './core/use-cases/restore-item.use-case';
import { GetItemUseCase } from './core/use-cases/get-item.use-case';
import { ListItemsUseCase } from './core/use-cases/list-items.use-case';
import { ImportItemsToProjectUseCase } from './core/use-cases/import-items-to-project.use-case';
import { PurgeItemUseCase } from './core/use-cases/purge-item.use-case';
import { BulkPurgeItemsUseCase } from './core/use-cases/bulk-purge-items.use-case';
import {
  CatalogDomainException,
  ItemNotFoundDomainException,
  ItemConcurrencyDomainException,
} from './core/domain/item-domain.exception';
import { VersionMismatchException } from '../shared-kernel/core/errors/version-mismatch.exception';
import { toValidProjectId } from '../shared-kernel';

import { ItemCurationController } from './item-curation.controller';

// Re-export ItemCurationController for clean modular import
export { ItemCurationController } from './item-curation.controller';

@ApiTags('Library Items - Catalog Lifecycle')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items',
  'api/v1/me/library/items',
  'api/v1/projects/:projectId/library/items',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ItemController {
  constructor(
    private readonly createItemUseCase: CreateItemUseCase,
    private readonly updateItemUseCase: UpdateItemUseCase,
    private readonly deleteItemUseCase: DeleteItemUseCase,
    private readonly restoreItemUseCase: RestoreItemUseCase,
    private readonly getItemUseCase: GetItemUseCase,
    private readonly listItemsUseCase: ListItemsUseCase,
    @Optional()
    private readonly importItemsToProjectUseCase?: ImportItemsToProjectUseCase,
    @Optional()
    private readonly purgeItemUseCase?: PurgeItemUseCase,
    @Optional()
    private readonly bulkPurgeItemsUseCase?: BulkPurgeItemsUseCase,
    @Optional()
    private readonly itemsService?: ItemsService,
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
      fields?: string;
    },
    @Param('projectId') projectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      projectId || (query as any)?.projectId,
    );
    const rawFields = (query as any)?.fields;
    const fieldsList =
      typeof rawFields === 'string'
        ? rawFields
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : Array.isArray(rawFields)
          ? rawFields
          : undefined;

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
      fields: fieldsList,
      projectId: effectiveProjectId,
    });
    return { items: result.items, pagination: result.pagination };
  }

  @Get('counts')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get summary item counts for system views' })
  async getCounts(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(projectId || queryProjectId);
    if (this.itemsService) {
      return this.itemsService.getCounts(userId, effectiveProjectId);
    }
    return { total: 0, unfiled: 0, starred: 0, trash: 0 };
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
    if (!this.importItemsToProjectUseCase) {
      throw new BadRequestException('Import use-case is not available');
    }
    return this.importItemsToProjectUseCase.execute({
      userId,
      projectId,
      itemIds: body.itemIds || [],
    });
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
    const item = await this.getItemUseCase!.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    return item;
  }

  @Get(':id/metadata-sources')
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

    const combinedFields = {
      ...otherFields,
      ...(extra !== undefined ? { extra: String(extra) } : {}),
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
      throw new BadRequestException('Invalid expectedVersion specified');
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
    if (!this.purgeItemUseCase) {
      throw new BadRequestException('Purge service unavailable');
    }
    const purged = await this.purgeItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    return { success: true, purged, id };
  }

  @Post('bulk-purge')
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Permanently purge multiple deleted items in batch',
  })
  async bulkPurgeItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkPurgeItemsDto,
    @Param('projectId') projectId?: string,
  ) {
    const itemIds = body?.itemIds || [];
    if (!this.bulkPurgeItemsUseCase) {
      throw new BadRequestException('Bulk purge service unavailable');
    }
    return this.bulkPurgeItemsUseCase.execute({
      userId,
      itemIds,
      projectId: toValidProjectId(projectId),
    });
  }
}

export const ItemsController = ItemController;
export type ItemsController = ItemController;
