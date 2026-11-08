import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
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
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { ArchiveService } from './archive.service';
import {
  BulkRestoreProjectArchivesDto,
  ProjectResponseDto,
  ProjectScopedArchivesResponseDto,
  QueryProjectArchivesDto,
} from './dto/archive.dto';

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
  @UseGuards(ProjectAccessGuard)
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
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Unarchive/restore a project to active status' })
  unarchiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.unarchive(projectId, userId);
  }

  @Get(':projectId/archives')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get project-scoped archived items (work items and pages) for a single project',
  })
  @ApiResponse({
    status: 200,
    type: ProjectScopedArchivesResponseDto,
  })
  getProjectArchives(
    @Param('projectId') projectId: string,
    @Query() query: QueryProjectArchivesDto,
  ) {
    return this.archiveService.getProjectArchives(projectId, query);
  }

  @Post(':projectId/archives/restore')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Restore archived work items and/or pages within a single project',
  })
  restoreProjectArchives(
    @Param('projectId') projectId: string,
    @Body() dto: BulkRestoreProjectArchivesDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.restoreProjectItems(projectId, dto, userId);
  }
}
