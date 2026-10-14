import {
  Controller,
  Get,
  Post,
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
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ArchiveService } from './archive.service';
import { BulkArchiveDto } from './dto/bulk-archive.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ArchiveController {
  constructor(private readonly archiveService: ArchiveService) {}

  @Post([
    'work-items/:workItemId/archive',
    'projects/:projectId/work-items/:workItemId/archive',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a work item (hides from active Kanban/List views)',
  })
  @ApiParam({
    name: 'workItemId',
    description: 'Work item UUID or identifier (e.g. FLUX-123)',
  })
  async archiveWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.archiveWorkItem(workItemId, userId);
  }

  @Post([
    'work-items/:workItemId/restore',
    'projects/:projectId/work-items/:workItemId/restore',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived work item to active boards' })
  @ApiParam({
    name: 'workItemId',
    description: 'Work item UUID or identifier (e.g. FLUX-123)',
  })
  async restoreWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.restoreWorkItem(workItemId, userId);
  }

  @Post([
    'work-items/bulk-archive',
    'projects/:projectId/work-items/bulk-archive',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk archive multiple work items' })
  async bulkArchive(
    @Body() bulkArchiveDto: BulkArchiveDto,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (projectId && !bulkArchiveDto.projectId) {
      bulkArchiveDto.projectId = projectId;
    }
    return this.archiveService.bulkArchiveWorkItems(bulkArchiveDto, userId);
  }

  @Post([
    'work-items/bulk-restore',
    'projects/:projectId/work-items/bulk-restore',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk restore multiple archived work items' })
  async bulkRestore(
    @Body() bulkArchiveDto: BulkArchiveDto,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (projectId && !bulkArchiveDto.projectId) {
      bulkArchiveDto.projectId = projectId;
    }
    return this.archiveService.bulkRestoreWorkItems(bulkArchiveDto, userId);
  }

  @Get([
    'projects/:projectId/work-items/archived',
    'work-items/projects/:projectId/archived',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List archived work items of a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'search', required: false, type: String })
  async getProjectArchivedWorkItems(
    @Param('projectId') projectId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.archiveService.getArchivedWorkItems(projectId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      search,
    });
  }
}
