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
import { CursorPaginationQueryDto } from '../common/library-contracts';

export class CreateCatalogItemDto {
  title!: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  fileUrl?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  collectionId?: string;
}

export class UpdateCatalogItemDto {
  title?: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  collectionId?: string | null;
  expectedVersion?: number;
}

@Controller('api/v1/workspaces/:workspaceId/library/items')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  async listItems(
    @Param('workspaceId') workspaceId: string,
    @Query()
    query: CursorPaginationQueryDto & {
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
  ) {
    const result = await this.catalogService.listItems(workspaceId, {
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
  ) {
    const item = await this.catalogService.getItem(workspaceId, id);
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
}
