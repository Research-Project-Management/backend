import { Controller, Get, Patch, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ArchiveService } from './archive.service';
import { ProjectResponseDto } from '../core/dto/response.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Project Archiving')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class ArchiveController {
  constructor(private readonly archiveService: ArchiveService) {}

  @Get('archived')
  @ApiOperation({ summary: 'List all archived projects for current user' })
  @ApiResponse({
    status: 200,
    description: 'List of archived projects',
    type: [ProjectResponseDto],
  })
  getArchivedProjects(@CurrentUser('id') userId: string) {
    return this.archiveService.findArchived(userId);
  }

  @Patch(':projectId/archive')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Archive a project (freezes data and hides from active lists)',
  })
  archiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.archive(projectId, userId);
  }

  @Patch([':projectId/unarchive', ':projectId/restore-archive'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Unarchive/restore a project to active status' })
  unarchiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.unarchive(projectId, userId);
  }
}
