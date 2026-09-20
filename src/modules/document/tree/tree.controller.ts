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
import { TreeService } from './tree.service';
import {
  MoveNodeDto,
  CreateChildNodeDto,
  SetMainNodeDto,
} from './dto/tree.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Document - Node & Tree')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TreeController {
  constructor(private readonly treeService: TreeService) {}

  @Get(['projects/:projectId/nodes/tree', 'projects/:projectId/tree'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get hierarchical document file tree and ordered node list for a project',
  })
  async getProjectTree(@Param('projectId') projectId: string) {
    return this.treeService.getProjectTree(projectId);
  }

  @Put([
    'nodes/:nodeId/move',
    'projects/:projectId/nodes/:nodeId/move',
    'tree/:nodeId/move',
    'projects/:projectId/tree/:nodeId/move',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
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
    return this.treeService.moveNode(nodeId, dto, projectId);
  }

  @Get([
    'nodes/:nodeId/ancestors',
    'projects/:projectId/nodes/:nodeId/ancestors',
    'tree/:nodeId/ancestors',
    'projects/:projectId/tree/:nodeId/ancestors',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get breadcrumb ancestor chain for a node (PostgreSQL Recursive CTE)',
  })
  async getAncestors(@Param('nodeId') nodeId: string) {
    return this.treeService.getAncestors(nodeId);
  }

  @Put([
    'nodes/:nodeId/main-file',
    'projects/:projectId/nodes/:nodeId/main-file',
    'tree/:nodeId/main-file',
    'projects/:projectId/tree/:nodeId/main-file',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
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
    return this.treeService.setMainFile(nodeId, dto.mainFileId, projectId);
  }

  @Get([
    'nodes/:nodeId/children',
    'projects/:projectId/nodes/:nodeId/children',
    'tree/:nodeId/children',
    'projects/:projectId/tree/:nodeId/children',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List direct children/sub-files of a node' })
  async getChildren(
    @Param('nodeId') nodeId: string,
    @Param('projectId') projectId?: string,
  ) {
    const res = await this.treeService.getChildren(nodeId, projectId);
    return { files: res.children, children: res.children };
  }

  @Post([
    'nodes/:nodeId/children',
    'projects/:projectId/nodes/:nodeId/children',
    'tree/:nodeId/children',
    'projects/:projectId/tree/:nodeId/children',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a child node within a parent folder/node' })
  async createChild(
    @Param('nodeId') nodeId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateChildNodeDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.treeService.createChildNode(nodeId, userId, dto, projectId);
  }
}
