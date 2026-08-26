import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RelationsService } from './relations.service';
import { LinkRelatedItemDto, LinkRelationItemDto } from './dto/relations.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Related Items & Knowledge Graph')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@Controller('api')
export class RelationsController {
  constructor(private readonly relationsService: RelationsService) {}

  @Get([
    'workspace/:workspaceId/library/knowledge/graph',
    'workspace/:workspaceId/library/graph',
    'workspaces/:workspaceId/library/relations/graph',
    'library/knowledge/:workspaceId/graph',
    'library/relations/:workspaceId/graph',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Get full knowledge graph (nodes and semantic edges) for the workspace library',
  })
  async getWorkspaceRelationGraph(@Param('workspaceId') workspaceId: string) {
    return this.relationsService.getWorkspaceRelationGraph(workspaceId);
  }

  @Get([
    'workspace/:workspaceId/library/items/:itemId/related',
    'workspaces/:workspaceId/library/relations/items/:itemId',
    'library/knowledge/:workspaceId/:itemId',
    'library/relations/:workspaceId/:itemId',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all items related to a specific library item' })
  async getRelatedItems(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.relationsService.getRelatedItems(workspaceId, itemId);
  }

  @Post([
    'workspace/:workspaceId/library/items/:itemId/related',
    'library/knowledge/:workspaceId/:itemId/link',
    'library/relations/:workspaceId/:itemId/link',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a symmetric relationship between two library items',
  })
  async linkItems(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: LinkRelatedItemDto,
  ) {
    return this.relationsService.linkItems(workspaceId, itemId, dto);
  }

  @Post('workspaces/:workspaceId/library/relations/items/:itemId')
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Link an item to another item semantically' })
  async linkDirectedItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: LinkRelationItemDto,
    @Req() req: any,
  ) {
    return this.relationsService.linkDirectedItems(
      workspaceId,
      itemId,
      dto,
      req.user?.id || '',
    );
  }

  @Delete([
    'workspace/:workspaceId/library/items/:itemId/related/:targetItemId',
    'library/knowledge/:workspaceId/:itemId/link/:targetItemId',
    'library/relations/:workspaceId/:itemId/link/:targetItemId',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Remove a relationship between two library items',
  })
  async unlinkItems(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('targetItemId') targetItemId: string,
  ) {
    return this.relationsService.unlinkItems(workspaceId, itemId, targetItemId);
  }

  @Delete(
    'workspaces/:workspaceId/library/relations/items/:itemId/target/:targetItemId',
  )
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Remove a semantic link between two items' })
  async unlinkDirectedItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('targetItemId') targetItemId: string,
    @Query('relationType') relationType?: string,
  ) {
    return this.relationsService.unlinkDirectedItems(
      workspaceId,
      itemId,
      targetItemId,
      relationType,
    );
  }
}

export { RelationsController as RelationGraphController };
