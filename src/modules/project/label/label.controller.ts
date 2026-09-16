import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { LabelService } from './label.service';
import { CreateProjectLabelDto, UpdateProjectLabelDto } from './dto/create-label.dto';
import { AssignProjectLabelsDto } from './dto/assign-label.dto';

@ApiTags('Project Labels')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1')
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  // ─── 1. User/Workspace-level Project Labels ────────────────────────────────

  @Get('project-labels')
  @ApiOperation({ summary: 'List all project labels defined by current user' })
  getUserLabels(@CurrentUser('id') userId: string) {
    return this.labelService.getUserLabels(userId);
  }

  @Post('project-labels')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new project label' })
  createLabel(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectLabelDto,
  ) {
    return this.labelService.createLabel(userId, dto);
  }

  @Patch('project-labels/:id')
  @ApiOperation({ summary: 'Update a project label' })
  updateLabel(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProjectLabelDto,
  ) {
    return this.labelService.updateLabel(id, userId, dto);
  }

  @Delete('project-labels/:id')
  @ApiOperation({ summary: 'Delete a project label' })
  deleteLabel(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.labelService.deleteLabel(id, userId);
  }

  // ─── 2. Project Assignment Endpoints ──────────────────────────────────────

  @Get('projects/:projectId/project-labels')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get labels assigned to a project' })
  getProjectLabels(@Param('projectId') projectId: string) {
    return this.labelService.getProjectLabels(projectId);
  }

  @Post('projects/:projectId/project-labels')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Assign labels to a project' })
  assignLabels(
    @Param('projectId') projectId: string,
    @Body() dto: AssignProjectLabelsDto,
  ) {
    return this.labelService.assignLabelsToProject(projectId, dto.labelIds);
  }

  @Delete('projects/:projectId/project-labels/:labelId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Remove a label from a project' })
  removeLabel(
    @Param('projectId') projectId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.labelService.removeLabelFromProject(projectId, labelId);
  }
}
