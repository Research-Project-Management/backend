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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ArchiveService } from './archive.service';
import { BulkArchiveDto } from './dto/bulk-archive.dto';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller('api/work-items')
@UseGuards(JwtAuthGuard)
export class ArchiveController {
  constructor(private readonly archiveService: ArchiveService) {}

  @Post(':taskId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a work item (hides from active Kanban/List views)' })
  @ApiParam({ name: 'taskId', description: 'Work item UUID or identifier (e.g. FLUX-123)' })
  async archiveWorkItem(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.archiveWorkItem(taskId, userId);
  }

  @Post(':taskId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived work item to active boards' })
  @ApiParam({ name: 'taskId', description: 'Work item UUID or identifier (e.g. FLUX-123)' })
  async restoreWorkItem(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.restoreWorkItem(taskId, userId);
  }

  @Post('bulk-archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk archive multiple work items' })
  async bulkArchive(
    @Body() bulkArchiveDto: BulkArchiveDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.bulkArchiveWorkItems(bulkArchiveDto, userId);
  }

  @Post('bulk-restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk restore multiple archived work items' })
  async bulkRestore(
    @Body() bulkArchiveDto: BulkArchiveDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.archiveService.bulkRestoreWorkItems(bulkArchiveDto, userId);
  }

  @Get('projects/:projectId/archived')
  @ApiOperation({ summary: 'List archived work items of a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'search', required: false, type: String })
  async getProjectArchivedTasks(
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
