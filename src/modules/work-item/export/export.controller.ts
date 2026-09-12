import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Res,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { ExportService } from './export.service';
import { ExportWorkItemsQueryDto } from './dto/export-query.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Work Item Export')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get([
    'projects/:projectId/work-items/export',
    'project/:projectId/work-items/export',
    'projects/:projectId/tasks/export',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Export work items for a project in CSV or JSON format' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  @ApiResponse({ status: 200, description: 'File download stream (CSV or JSON)' })
  async exportProjectTasks(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ExportWorkItemsQueryDto,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.exportService.exportProjectWorkItems(
      projectId,
      query,
    );

    reply
      .header('Content-Type', result.contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`,
      )
      .send(result.data);
  }

  @Get([
    'workspaces/:workspaceId/work-items/export',
    'workspace/:workspaceId/work-items/export',
    'workspaces/:workspaceId/tasks/export',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Export work items for an entire workspace in CSV or JSON format' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace UUID' })
  @ApiResponse({ status: 200, description: 'File download stream (CSV or JSON)' })
  async exportWorkspaceTasks(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ExportWorkItemsQueryDto,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.exportService.exportWorkspaceWorkItems(
      workspaceId,
      query,
    );

    reply
      .header('Content-Type', result.contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`,
      )
      .send(result.data);
  }
}
