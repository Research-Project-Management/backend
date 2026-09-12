import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { LabelService } from './label.service';
import {
  CreateProjectLabelDto,
  UpdateProjectLabelDto,
  ReorderLabelsDto,
  CreateLabelDto,
  UpdateLabelDto,
  QueryLabelDto,
  ImportLabelsDto,
} from './dto/label.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentWorkspace } from '@/modules/iam/authz/decorators/current-workspace.decorator';

@ApiTags('Work Item Labels')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  // ── 1. Project-Scoped Endpoints ───────────────────────────────────────────

  @Get([
    'projects/:projectId/labels',
    'project/:projectId/labels',
    'workspaces/:workspaceId/projects/:projectId/labels',
    'workspace/:workspaceId/projects/:projectId/labels',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'List all project labels with hierarchical sub-labels',
  })
  @ApiResponse({ status: 200, description: 'Project labels tree' })
  async getProjectLabels(@Param('projectId') projectId: string) {
    return this.labelService.getProjectLabels(projectId);
  }

  @Post([
    'projects/:projectId/labels',
    'project/:projectId/labels',
    'workspaces/:workspaceId/projects/:projectId/labels',
    'workspace/:workspaceId/projects/:projectId/labels',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Create a new project label (Admin only)' })
  @ApiResponse({ status: 201, description: 'Label created successfully' })
  async createProjectLabel(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectLabelDto,
  ) {
    return this.labelService.createProjectLabel(projectId, userId, dto);
  }

  @Get([
    'projects/:projectId/labels/:labelId',
    'project/:projectId/labels/:labelId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a specific project label' })
  async getProjectLabelById(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.labelService.getProjectLabelById(projectId, labelId);
  }

  @Patch([
    'projects/:projectId/labels/:labelId',
    'project/:projectId/labels/:labelId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Update project label attributes or parent (Admin only)',
  })
  async updateProjectLabel(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
    @Body() dto: UpdateProjectLabelDto,
  ) {
    return this.labelService.updateProjectLabel(projectId, labelId, dto);
  }

  @Put([
    'projects/:projectId/labels/:labelId',
    'project/:projectId/labels/:labelId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Update project label (PUT alias for admin)' })
  async putProjectLabel(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
    @Body() dto: UpdateProjectLabelDto,
  ) {
    return this.labelService.updateProjectLabel(projectId, labelId, dto);
  }

  @Delete([
    'projects/:projectId/labels/:labelId',
    'project/:projectId/labels/:labelId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Delete project label and detach from tasks (Admin only)',
  })
  async deleteProjectLabel(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.labelService.deleteProjectLabel(projectId, labelId);
  }

  @Post([
    'projects/:projectId/labels/reorder',
    'project/:projectId/labels/reorder',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Reorder project labels sequence (Admin only)' })
  async reorderProjectLabels(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderLabelsDto,
  ) {
    return this.labelService.reorderProjectLabels(projectId, dto);
  }

  @Post([
    'projects/:projectId/labels/import',
    'project/:projectId/labels/import',
    'workspaces/:workspaceId/projects/:projectId/labels/import',
    'workspace/:workspaceId/projects/:projectId/labels/import',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Bulk import labels into project from CSV data (Admin only)',
  })
  @ApiResponse({
    status: 201,
    description: 'Labels imported with summary stats',
  })
  async importProjectLabels(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ImportLabelsDto,
  ) {
    return this.labelService.importProjectLabels(projectId, userId, dto);
  }

  // ── 2. Legacy Workspace Endpoints (Preserved for Backward Compatibility) ─────

  @Get([
    'workspaces/:workspaceId/labels',
    'workspace/:workspaceId/labels',
    'labels/:workspaceId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List labels in a workspace (Legacy)' })
  async getLabels(
    @Param('workspaceId') workspaceId: string,
    @Query() query?: QueryLabelDto,
  ) {
    if (query?.projectId) {
      return this.labelService.getProjectLabels(query.projectId);
    }
    return this.labelService.getLabels(workspaceId, query?.type);
  }

  @Post([
    'workspaces/:workspaceId/labels',
    'workspace/:workspaceId/labels',
    'labels/:workspaceId',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Create a label in a workspace (Legacy)' })
  async createLabel(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateLabelDto,
  ) {
    return this.labelService.createLabel(workspaceId, userId, dto);
  }

  @Put('labels/:labelId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Update a label by ID (Legacy)' })
  async updateLabel(
    @Param('labelId') labelId: string,
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labelService.updateLabel(labelId, dto, workspaceId);
  }

  @Delete('labels/:labelId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Delete a label by ID (Legacy)' })
  async deleteLabel(
    @Param('labelId') labelId: string,
    @CurrentWorkspace() workspaceId: string,
  ) {
    return this.labelService.deleteLabel(labelId, workspaceId);
  }
}
