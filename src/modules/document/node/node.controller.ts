import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NodeService } from './node.service';
import {
  MoveNodeDto,
  CreateChildNodeDto,
  SetMainNodeDto,
} from './dto/node.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Node & Tree')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class NodeController {
  constructor(private readonly nodeService: NodeService) {}

  @Get([
    'projects/:projectId/nodes/tree',
    'projects/:projectId/tree',
    'project/:projectId/tree',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get hierarchical document file tree and ordered node list for a project',
  })
  async getProjectTree(@Param('projectId') projectId: string) {
    return this.nodeService.getProjectTree(projectId);
  }

  @Put(['projects/:projectId/nodes/:nodeId/move', 'nodes/:nodeId/move'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Move or reorder a node within the document tree (drag & drop re-parenting)',
  })
  async moveNode(
    @Param('nodeId') nodeId: string,
    @Body() dto: MoveNodeDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.nodeService.moveNode(nodeId, dto, projectId);
  }

  @Get([
    'projects/:projectId/nodes/:nodeId/ancestors',
    'nodes/:nodeId/ancestors',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get breadcrumb ancestor chain for a node (PostgreSQL Recursive CTE)',
  })
  async getAncestors(@Param('nodeId') nodeId: string) {
    return this.nodeService.getAncestors(nodeId);
  }

  @Put([
    'projects/:projectId/nodes/:nodeId/main-file',
    'nodes/:nodeId/main-file',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Designate a file node as primary compilation entry-point (e.g. main.tex)',
  })
  async setMainFile(
    @Param('nodeId') nodeId: string,
    @Body() dto: SetMainNodeDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.nodeService.setMainFile(nodeId, dto.mainFileId, projectId);
  }

  @Get(['projects/:projectId/nodes/:nodeId/children', 'nodes/:nodeId/children'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List direct children/sub-files of a node' })
  async getChildren(
    @Param('nodeId') nodeId: string,
    @Param('projectId') projectId?: string,
  ) {
    const res = await this.nodeService.getChildren(nodeId, projectId);
    return { files: res.children, children: res.children };
  }

  @Post([
    'projects/:projectId/nodes/:nodeId/children',
    'nodes/:nodeId/children',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({
    summary: 'Create a child node or sub-file within a parent node',
  })
  async createChildNode(
    @Param('nodeId') nodeId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateChildNodeDto,
    @Param('projectId') projectId?: string,
  ) {
    const res = await this.nodeService.createChildNode(
      nodeId,
      userId,
      dto,
      projectId,
    );
    return { page: res.node, file: res.node, node: res.node };
  }
}

export const TreeController = NodeController;
export type TreeController = NodeController;
