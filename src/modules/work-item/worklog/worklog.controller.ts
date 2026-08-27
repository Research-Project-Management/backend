import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
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
import { WorklogService } from './worklog.service';
import {
  CreateWorklogDto,
  UpdateWorklogDto,
  QueryWorklogDto,
} from './dto/worklog.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Work Item - Worklogs')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class WorklogController {
  constructor(private readonly worklogService: WorklogService) {}

  @Get(['projects/:projectId/worklogs', 'project/:projectId/worklogs'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get project worklogs with filtering and pagination',
  })
  @ApiResponse({ status: 200, description: 'Paginated project worklogs' })
  async getProjectWorklogs(
    @Param('projectId') projectId: string,
    @Query() query: QueryWorklogDto,
  ) {
    return this.worklogService.getProjectWorklogs(projectId, query);
  }

  @Post(['projects/:projectId/worklogs', 'project/:projectId/worklogs'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Log work hours for a project or specific work item',
  })
  @ApiResponse({ status: 201, description: 'Created worklog entry' })
  async createWorklog(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorklogDto,
  ) {
    return this.worklogService.createWorklog(projectId, userId, dto);
  }

  @Get(['workspaces/:workspaceId/worklogs', 'workspace/:workspaceId/worklogs'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get workspace consolidated worklogs' })
  @ApiResponse({ status: 200, description: 'Paginated workspace worklogs' })
  async getWorkspaceWorklogs(
    @Param('workspaceId') workspaceId: string,
    @Query() query: QueryWorklogDto,
  ) {
    return this.worklogService.getWorkspaceWorklogs(workspaceId, query);
  }

  @Delete('worklogs/:id')
  @ApiOperation({ summary: 'Delete a worklog entry' })
  @ApiResponse({ status: 200, description: 'Worklog deletion confirmation' })
  async deleteWorklog(@Param('id') id: string) {
    return this.worklogService.deleteWorklog(id);
  }

  @Put('worklogs/:id')
  @ApiOperation({
    summary: 'Update a worklog entry (hours, description, date, task)',
  })
  @ApiResponse({ status: 200, description: 'Updated worklog entry' })
  async updateWorklog(@Param('id') id: string, @Body() dto: UpdateWorklogDto) {
    return this.worklogService.updateWorklog(id, dto);
  }
}
