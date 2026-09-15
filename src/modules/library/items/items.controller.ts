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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ItemsService } from './items.service';
import {
  ITEM_NOTES_EXTRACTOR_PORT,
  IItemNotesExtractorPort,
} from './ports/items.ports';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../modules/iam/authz/decorators/role.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import {
  CursorPaginationQueryDto,
  CreateItemDto,
  UpdateItemDto,
} from './dto/items.dto';

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
    private readonly itemsService: ItemsService,
    @Optional()
    @Inject(ITEM_NOTES_EXTRACTOR_PORT)
    private readonly notesExtractor?: IItemNotesExtractorPort,
  ) {}

  @Get()
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
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
    const effectiveProjectId = projectId || (query as any)?.projectId;
    const result = await this.itemsService.listItems(userId, {
      view: query?.view,
      collectionId: query?.collectionId,
      tagId: query?.tagId,
      search: query?.search,
      cursor: query?.cursor,
      limit: query?.limit,
      projectId: effectiveProjectId,
    });
    return { items: result.items, pagination: result.meta };
  }

  @Post('import')
  @ProjectRoles('owner', 'contributor')
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
    return this.itemsService.importItemsToProject(
      userId,
      projectId,
      body.itemIds || [],
    );
  }

  @Get(':id')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a library item by ID' })
  async getItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    const item = await this.itemsService.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    return item;
  }

  @Get(':id/fulltext')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get fulltext of an item' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const fulltext = await this.itemsService.getFulltext(userId, id);
    if (!fulltext) {
      throw new NotFoundException(
        `Full-text structured extraction not found for item ${id}`,
      );
    }
    return fulltext;
  }

  @Post()
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Create a new library item' })
  async createItem(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string | undefined,
    @Body() body: CreateItemDto,
  ) {
    const {
      citationCount: _c,
      referenceCount: _r,
      crossrefEnriched: _cr,
      ...cleanBody
    } = body;
    return this.itemsService.createItem(userId, {
      ...cleanBody,
      uploadedById: userId || 'system',
      projectId: projectId || cleanBody.projectId,
    });
  }

  @Patch(':id')
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update a library item' })
  async updateItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
    @Param('projectId') projectId?: string,
  ) {
    const parsedHeaderVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const expectedVersion =
      body.expectedVersion ??
      (!isNaN(parsedHeaderVersion as number) ? parsedHeaderVersion : undefined);
    if (
      expectedVersion === undefined ||
      isNaN(expectedVersion) ||
      expectedVersion < 0
    ) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }
    const {
      expectedVersion: _,
      citationCount: _c,
      referenceCount: _r,
      crossrefEnriched: _cr,
      ...updateData
    } = body;
    return this.itemsService.updateItem(
      userId,
      id,
      expectedVersion,
      updateData,
      undefined,
      projectId,
    );
  }

  @Put(':id')
  @ProjectRoles('owner', 'contributor')
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
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Reindex a library item' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.itemsService.reindexItem(userId, id, projectId);
  }

  @Post(':id/convert-type/preview')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Preview type conversion of an item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
    @Param('projectId') projectId?: string,
  ) {
    const item = await this.itemsService.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
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
  @ProjectRoles('owner', 'contributor')
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
    const result = await this.itemsService.convertItemType(
      userId,
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
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Delete an item (soft delete)' })
  async deleteItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Param('projectId') projectId?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const deleted = await this.itemsService.deleteItem(
      userId,
      id,
      expectedVersion,
      undefined,
      projectId,
    );
    return { success: true, deleted, id };
  }

  @Post(':id/restore')
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Restore a deleted item' })
  async restoreItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Param('projectId') projectId?: string,
  ) {
    const expectedVersion =
      expectedVersionQuery !== undefined
        ? parseInt(expectedVersionQuery, 10)
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    const item = await this.itemsService.restoreItem(
      userId,
      id,
      expectedVersion,
      projectId,
    );
    return { success: true, data: item, item };
  }

  @Delete(':id/purge')
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Permanently purge a deleted item' })
  async purgeItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    const purged = await this.itemsService.purgeItem(userId, id, projectId);
    return { success: true, purged, id };
  }

  @Get(':id/relations')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get related items' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.itemsService.getRelatedItems(userId, id, projectId);
  }

  @Post([':id/relations', ':id/link'])
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Link two items together' })
  async linkItems(
    @Param('id') id: string,
    @Body()
    body: { targetItemId: string; relationType?: string; note?: string },
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.itemsService.linkItems(userId, id, body, projectId);
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Unlink items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.itemsService.unlinkItems(userId, id, targetItemId, projectId);
  }

  @Post(':id/my-publication')
  @ApiOperation({ summary: 'Mark an item as my publication' })
  async markMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const item = await this.itemsService.setMyPublication(userId, id, true);
    return { success: true, data: item, item };
  }

  @Delete(':id/my-publication')
  @ApiOperation({ summary: 'Unmark an item as my publication' })
  async unmarkMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const item = await this.itemsService.setMyPublication(userId, id, false);
    return { success: true, data: item, item };
  }
}
