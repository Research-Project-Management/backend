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
import { ItemsService } from './items.service';
import { ConversionService } from './conversion.service';
import { NotesService } from '../notes/notes.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';
import { CursorPaginationQueryDto } from './items.dto';
import { CreateCatalogItemDto, UpdateCatalogItemDto } from './items.dto';

@Controller('api/v1/workspaces/:workspaceId/library/items')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ItemsController {
  constructor(
    private readonly itemsService: ItemsService,
    private readonly conversionService: ConversionService,
    @Optional()
    private readonly notesService?: NotesService,
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
    const result = await this.itemsService.listItems(targetWsId, {
      view: query.view,
      userId: currentUserId,
      collectionId: query.collectionId,
      tagId: query.tagId,
      search: query.search,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: result.items, pagination: result.meta };
  }

  @Get(':id')
  async getItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const item = await this.itemsService.getItem(
      targetWsId,
      id,
      currentUserId,
    );
    if (!item)
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${targetWsId}`,
      );
    return item;
  }

  @Post()
  async createItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateCatalogItemDto,
  ) {
    return this.itemsService.createItem(currentWorkspaceId || workspaceId, {
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
    if (!expectedVersion || isNaN(expectedVersion)) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }
    const { expectedVersion: _, ...updateData } = body;
    return this.itemsService.updateItem(
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
    return this.itemsService.reindexItem(
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
    const item = await this.itemsService.getItem(
      targetWsId,
      id,
      currentUserId,
    );
    if (!item) {
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${targetWsId}`,
      );
    }
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
    const deleted = await this.itemsService.deleteItem(
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
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion =
      expectedVersionQuery !== undefined
      ? parseInt(expectedVersionQuery, 10)
      : ifMatch
        ? parseInt(ifMatch.replace(/["']/g, ''), 10)
        : undefined;
    const item = await this.itemsService.restoreItem(
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
    const purged = await this.itemsService.purgeItem(
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
    return this.itemsService.getRelatedItems(
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
    return this.itemsService.linkItems(
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
    return this.itemsService.unlinkItems(
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
    if (!this.notesService) {
      throw new BadRequestException('NotesService is not available');
    }
    return this.notesService.extractNotesFromAnnotations(
      currentWorkspaceId || workspaceId,
      id,
      currentUserId,
    );
  }
}

export const CatalogController = ItemsController;
export type CatalogController = ItemsController;
