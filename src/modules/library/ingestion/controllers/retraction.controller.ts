import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  FlagRetractionDto,
  BatchCheckRetractionDto,
  SyncRetractionDto,
} from '@/modules/library/ingestion/dto/retraction.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Library Retraction')
@ApiBearerAuth()
@Controller([
  'api/v1/library/retraction',
  'api/v1/projects/:projectId/library/retraction',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class RetractionController {
  constructor(private readonly service: RetractionService) {}

  @Get('database/stats')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getDatabaseStats() {
    return this.service.getDatabaseStats();
  }

  @Post('database/seed')
  @ProjectRoles('owner')
  async seedDatabase(
    @CurrentUser('id') _userId: string,
    @CurrentUser('role') role?: string,
    @Body('force') force?: boolean,
  ) {
    if (role !== 'admin' && role !== 'superadmin' && role !== 'system') {
      throw new ForbiddenException(
        'System administrator privilege is required to seed the global retraction database',
      );
    }
    return this.service.seedDatabase(Boolean(force));
  }

  @Get('items')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getRetractedItems(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.getRetractedItems(userId, effectiveProjectId);
  }

  @Get('stats')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getStats(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.getStats(userId, effectiveProjectId);
  }

  @Post('check-all')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async checkLibrary(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchCheckRetractionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.checkLibrary(userId, dto, effectiveProjectId);
  }

  @Post('sync')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async syncLibrary(
    @CurrentUser('id') userId: string,
    @Body() dto?: SyncRetractionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.syncLibrary(userId, effectiveProjectId, {
      maxDays: dto?.maxDays ? Number(dto.maxDays) : undefined,
      limit: dto?.limit ? Number(dto.limit) : undefined,
    });
  }

  @Post('items/:itemId/check')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async checkItem(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.checkItem(userId, itemId, effectiveProjectId);
  }

  @Post('items/:itemId/flag')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async setManualFlag(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: FlagRetractionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.setManualFlag(userId, itemId, dto, effectiveProjectId);
  }

  @Delete('items/:itemId/flag')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async removeManualFlag(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.removeManualFlag(userId, itemId, effectiveProjectId);
  }
}
