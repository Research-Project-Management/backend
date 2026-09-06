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
  Inject,
} from '@nestjs/common';
import { ItemsService } from './items.service';
import {
  ITEM_NOTES_EXTRACTOR_PORT,
  IItemNotesExtractorPort,
} from './ports/items.ports';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import {
  CursorPaginationQueryDto,
  CreateCatalogItemDto,
  UpdateCatalogItemDto,
} from './dto/items.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items',
  'api/v1/workspace/:workspaceId/library/items',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ItemsController {
  constructor(
    private readonly itemsService: ItemsService,
    @Optional()
    @Inject(ITEM_NOTES_EXTRACTOR_PORT)
    private readonly notesExtractor?: IItemNotesExtractorPort,
  ) {}


  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async listItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Query()
    query: CursorPaginationQueryDto & {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
  ) {
    const result = await this.itemsService.listItems(workspaceId, {
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
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    const item = await this.itemsService.getItem(
      workspaceId,
      id,
      currentUserId,
    );
    if (!item)
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${workspaceId}`,
      );
    return item;
  }

  @Post()
  @WorkspaceRoles('owner', 'admin', 'member')
  async createItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateCatalogItemDto,
  ) {
    return this.itemsService.createItem(workspaceId, {
      ...body,
      uploadedById: currentUserId || 'system',
    });
  }

  @Patch(':id')
  @WorkspaceRoles('owner', 'admin', 'member')
  async updateItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateCatalogItemDto,
  ) {
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
      workspaceId,
      id,
      expectedVersion,
      updateData,
    );
  }

  @Put(':id')
  @WorkspaceRoles('owner', 'admin', 'member')
  async replaceItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateCatalogItemDto,
  ) {
    return this.updateItem(workspaceId, id, ifMatch, body);
  }

  @Post(':id/reindex')
  @WorkspaceRoles('owner', 'admin', 'member')
  async reindexItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    return this.itemsService.reindexItem(
      workspaceId,
      id,
      currentUserId || 'system',
    );
  }

  @Post(':id/convert-type/preview')
  @WorkspaceRoles('owner', 'admin', 'member')
  async previewTypeConversion(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
  ) {
    const item = await this.itemsService.getItem(
      workspaceId,
      id,
      currentUserId,
    );
    if (!item) {
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${workspaceId}`,
      );
    }
    const preview = this.itemsService.previewTypeConversion(
      item,
      body.targetType,
      {
        retainUnmappedInExtra: body.retainUnmappedInExtra ?? true,
      },
    );
    return { success: true, preview, data: preview };
  }

  @Post(':id/convert-type')
  @WorkspaceRoles('owner', 'admin', 'member')
  async convertItemType(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
    @Body()
    body?: {
      targetType: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
  ) {
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    const result = await this.itemsService.convertItemType(
      workspaceId,
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
  @WorkspaceRoles('owner', 'admin')
  async deleteItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const deleted = await this.itemsService.deleteItem(
      workspaceId,
      id,
      expectedVersion,
    );
    return { success: true, deleted, id };
  }

  @Post(':id/restore')
  @WorkspaceRoles('owner', 'admin', 'member')
  async restoreItem(
    @Param('workspaceId') workspaceId: string,
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
      workspaceId,
      id,
      expectedVersion,
    );
    return { success: true, data: item, item };
  }

  @Delete(':id/purge')
  @WorkspaceRoles('owner', 'admin')
  async purgeItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    const purged = await this.itemsService.purgeItem(
      workspaceId,
      id,
    );
    return { success: true, purged, id };
  }

  @Get(':id/relations')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getRelatedItems(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.itemsService.getRelatedItems(
      workspaceId,
      id,
    );
  }

  @Post([':id/relations', ':id/link'])
  @WorkspaceRoles('owner', 'admin', 'member')
  async linkItems(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body()
    body: { targetItemId: string; relationType?: string; note?: string },
  ) {
    return this.itemsService.linkItems(
      workspaceId,
      id,
      body,
    );
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @WorkspaceRoles('owner', 'admin', 'member')
  async unlinkItems(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
  ) {
    return this.itemsService.unlinkItems(
      workspaceId,
      id,
      targetItemId,
    );
  }

  @Post(':id/extract-notes')
  @WorkspaceRoles('owner', 'admin', 'member')
  async extractNotes(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    if (!this.notesExtractor) {
      throw new BadRequestException('NotesService is not available');
    }
    return this.notesExtractor.extractNotesFromAnnotations(
      workspaceId,
      id,
      currentUserId,
    );
  }
}

export const CatalogController = ItemsController;
export type CatalogController = ItemsController;
