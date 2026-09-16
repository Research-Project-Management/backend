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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Work Item Labels')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  // ── 1. Project-Scoped Endpoints (Canonical) ──────────────────────────────

  @Get(['projects/:projectId/labels', 'project/:projectId/labels'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'List all project labels with hierarchical sub-labels',
  })
  @ApiResponse({ status: 200, description: 'Project labels tree' })
  async getProjectLabels(
    @Param('projectId') projectId: string,
    @Query() query?: QueryLabelDto,
  ) {
    return this.labelService.getProjectLabels(projectId, query?.type);
  }

  @Post(['projects/:projectId/labels', 'project/:projectId/labels'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Create a new project label' })
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
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
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
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({
    summary: 'Update project label attributes or parent',
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
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update project label (PUT alias)' })
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
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Delete project label and detach from work items',
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
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Reorder project labels sequence' })
  async reorderProjectLabels(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderLabelsDto,
  ) {
    return this.labelService.reorderProjectLabels(projectId, dto);
  }

  @Post([
    'projects/:projectId/labels/import',
    'project/:projectId/labels/import',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Bulk import labels into project from CSV data',
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

  // ── 2. Generic Labels Endpoints (Scoped to Project or User) ─────────────────

  @Get('labels')
  @ApiOperation({ summary: 'List user or project labels' })
  async getLabels(
    @CurrentUser('id') userId: string,
    @Query() query?: QueryLabelDto,
  ) {
    if (query?.projectId) {
      return this.labelService.getProjectLabels(query.projectId);
    }
    return this.labelService.getLabels(userId, query?.type, undefined);
  }

  @Post('labels')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a label' })
  async createLabel(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateLabelDto,
  ) {
    if (dto.projectId) {
      return this.labelService.createProjectLabel(dto.projectId, userId, dto);
    }
    return this.labelService.createLabel(userId, dto);
  }

  @Patch('labels/:labelId')
  @Put('labels/:labelId')
  @ApiOperation({ summary: 'Update a label by ID' })
  async updateLabel(
    @Param('labelId') labelId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labelService.updateLabel(labelId, dto, userId);
  }

  @Delete('labels/:labelId')
  @ApiOperation({ summary: 'Delete a label by ID' })
  async deleteLabel(
    @Param('labelId') labelId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.labelService.deleteLabel(labelId, userId);
  }

  @Post('labels/import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import labels from CSV data',
  })
  async importLabels(
    @CurrentUser('id') userId: string,
    @Body() dto: ImportLabelsDto,
  ) {
    return this.labelService.importUserLabels(userId, dto);
  }
}
