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
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { ItemTypeConversionService } from './services/item-type-conversion.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';
import { CursorPaginationQueryDto } from './dto/pagination.dto';
import { CreateCatalogItemDto, UpdateCatalogItemDto } from './dto/item.dto';
import { MergeDuplicatesDto } from './dto/duplicate.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items',
  'api/v1/workspaces/:workspaceId/library/curation',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CatalogController {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly conversionService: ItemTypeConversionService,
  ) {}

  @Get()
  async listItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Query()
    query: CursorPaginationQueryDto & {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const result = await this.catalogService.listItems(targetWsId, {
      view: query.view,
      userId: currentUserId,
      collectionId: query.collectionId,
      tagId: query.tagId,
      search: query.search,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: result.items, meta: result.meta, pagination: result.meta };
  }

  @Get('duplicates')
  async getDuplicates(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
  ) {
    return this.catalogService.detectDuplicates(
      currentWorkspaceId || workspaceId,
    );
  }

  @Post('merge')
  async mergeDuplicates(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Body() dto: MergeDuplicatesDto,
  ) {
    return this.catalogService.mergeDuplicates(
      currentWorkspaceId || workspaceId,
      dto,
    );
  }

  @Get(['quality-audit', 'integrity'])
  async getQualityAudit(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
  ) {
    return this.catalogService.getQualityAudit(
      currentWorkspaceId || workspaceId,
    );
  }

  @Get(':id')
  async getItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const item = await this.catalogService.getItem(
      targetWsId,
      id,
      currentUserId,
    );
    if (!item)
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${targetWsId}`,
      );
    return { item, data: item };
  }

  @Post()
  async createItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateCatalogItemDto,
  ) {
    return this.catalogService.createItem(currentWorkspaceId || workspaceId, {
      ...body,
      uploadedById: currentUserId || 'system',
    });
  }

  @Patch(':id')
  async updateItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateCatalogItemDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const parsedHeaderVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const expectedVersion =
      body.expectedVersion ??
      (!isNaN(parsedHeaderVersion as number) ? parsedHeaderVersion : undefined);
    const { expectedVersion: _, ...updateData } = body;
    return this.catalogService.updateItem(
      targetWsId,
      id,
      expectedVersion,
      updateData,
    );
  }

  @Put(':id')
  async replaceItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateCatalogItemDto,
  ) {
    return this.updateItem(workspaceId, currentWorkspaceId, id, ifMatch, body);
  }

  @Post(':id/reindex')
  async reindexItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    return this.catalogService.reindexItem(
      currentWorkspaceId || workspaceId,
      id,
      currentUserId || 'system',
    );
  }

  @Post(':id/convert-type/preview')
  async previewTypeConversion(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const item = await this.catalogService.getItem(
      targetWsId,
      id,
      currentUserId,
    );
    if (!item)
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${targetWsId}`,
      );
    const preview = this.conversionService.previewConversion(
      item,
      body.targetType,
      {
        retainUnmappedInExtra: body.retainUnmappedInExtra ?? true,
      },
    );
    return { success: true, preview, data: preview };
  }

  @Post(':id/convert-type')
  async convertItemType(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
    @Body()
    body?: {
      targetType: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    const result = await this.conversionService.convertItemType(
      targetWsId,
      id,
      body?.targetType || 'journalArticle',
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

  @Delete(':id')
  async deleteItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const deleted = await this.catalogService.deleteItem(
      currentWorkspaceId || workspaceId,
      id,
      expectedVersion,
    );
    return { success: true, deleted, id };
  }

  @Post(':id/restore')
  async restoreItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const item = await this.catalogService.restoreItem(
      currentWorkspaceId || workspaceId,
      id,
      expectedVersion,
    );
    return { success: true, data: item, item };
  }

  @Delete(':id/purge')
  async purgeItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
  ) {
    const purged = await this.catalogService.purgeItem(
      currentWorkspaceId || workspaceId,
      id,
    );
    return { success: true, purged, id };
  }

  @Get(':id/relations')
  async getRelatedItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
  ) {
    return this.catalogService.getRelatedItems(
      currentWorkspaceId || workspaceId,
      id,
    );
  }

  @Post([':id/relations', ':id/link'])
  async linkItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Body()
    body: { targetItemId: string; relationType?: string; note?: string },
  ) {
    return this.catalogService.linkItems(
      currentWorkspaceId || workspaceId,
      id,
      body,
    );
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  async unlinkItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @Param('targetId') targetId: string,
  ) {
    return this.catalogService.unlinkItems(
      currentWorkspaceId || workspaceId,
      id,
      targetId,
    );
  }

  @Post(':id/extract-notes')
  async extractNotes(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    return this.catalogService.extractNotesFromAnnotations(
      currentWorkspaceId || workspaceId,
      id,
      currentUserId,
    );
  }
}
