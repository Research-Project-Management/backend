import {
  Controller,
  Get,
  Post,
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
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { CursorPaginationQueryDto } from './dto/pagination.dto';
import { CreateCatalogItemDto, UpdateCatalogItemDto } from './dto/item.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items',
  'api/workspace/:workspaceId/library/items',
  'api/library/papers/:workspaceId',
  'api/library/:workspaceId/items',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
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
    const result = await this.catalogService.listItems(workspaceId, {
      view: query.view,
      userId: currentUserId,
      collectionId: query.collectionId,
      tagId: query.tagId,
      search: query.search,
      cursor: query.cursor,
      limit: query.limit,
    });

    return {
      success: true,
      data: result.items,
      meta: result.meta,
    };
  }

  @Get(':id')
  async getItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
  ) {
    const item = await this.catalogService.getItem(
      workspaceId,
      id,
      currentUserId,
    );
    if (!item) {
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${workspaceId}`,
      );
    }

    return {
      success: true,
      data: item,
    };
  }

  @Post()
  async createItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateCatalogItemDto,
  ) {
    const item = await this.catalogService.createItem(workspaceId, {
      ...body,
      uploadedById: currentUserId || 'system',
    });

    return {
      success: true,
      data: item,
    };
  }

  @Patch(':id')
  async updateItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateCatalogItemDto,
  ) {
    const expectedVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/["']/g, ''), 10) : undefined);
    if (!expectedVersion || isNaN(expectedVersion)) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }

    const { expectedVersion: _, ...updateData } = body;
    const updated = await this.catalogService.updateItem(
      workspaceId,
      id,
      expectedVersion,
      updateData,
    );

    return {
      success: true,
      data: updated,
    };
  }

  @Delete(':id')
  async deleteItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const deleted = await this.catalogService.deleteItem(
      workspaceId,
      id,
      expectedVersion,
    );

    return {
      success: true,
      data: { deleted },
    };
  }

  @Post(':id/restore')
  async restoreItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const restored = await this.catalogService.restoreItem(
      workspaceId,
      id,
      expectedVersion,
    );

    return {
      success: true,
      data: restored,
    };
  }

  @Delete(':id/purge')
  async purgeItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    const purged = await this.catalogService.purgeItem(workspaceId, id);

    return {
      success: true,
      data: { purged },
    };
  }

  @Get([':id/relations', 'api/library/relations/:workspaceId/:id'])
  async getRelatedItems(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.catalogService.getRelatedItems(workspaceId, id);
  }

  @Post([':id/relations', 'api/library/relations/:workspaceId/:id/link'])
  async linkItems(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: { targetItemId: string; relationType?: string; note?: string },
  ) {
    return this.catalogService.linkItems(workspaceId, id, body);
  }

  @Delete([
    ':id/relations/:targetId',
    'api/library/relations/:workspaceId/:id/link/:targetId',
  ])
  async unlinkItems(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('targetId') targetId: string,
  ) {
    return this.catalogService.unlinkItems(workspaceId, id, targetId);
  }
}

