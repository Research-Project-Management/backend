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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { ArchiveService } from './archive.service';
import { BulkArchiveDto } from './dto/bulk-archive.dto';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/work-items', 'api/work-items'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ArchiveController {
  constructor(private readonly archiveService: ArchiveService) {}

  @Post(':workItemId/archive')
  @ProjectRoles('owner', 'contributor')
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

  @Post(':workItemId/restore')
  @ProjectRoles('owner', 'contributor')
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

  @Post('bulk-archive')
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk archive multiple work items' })
  async bulkArchive(
    @Body() bulkArchiveDto: BulkArchiveDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.bulkArchiveWorkItems(bulkArchiveDto, userId);
  }

  @Post('bulk-restore')
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk restore multiple archived work items' })
  async bulkRestore(
    @Body() bulkArchiveDto: BulkArchiveDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.bulkRestoreWorkItems(bulkArchiveDto, userId);
  }

  @Get('projects/:projectId/archived')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
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
