import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { RetractionService } from './retraction.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../modules/iam/authz/decorators/role.decorator';
import {
  FlagRetractionDto,
  BatchCheckRetractionDto,
} from './dto/retraction.dto';

@Controller([
  'api/v1/library/retraction',
  'api/v1/projects/:projectId/library/retraction',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class RetractionController {
  constructor(private readonly service: RetractionService) {}

  @Get('database/stats')
  @ProjectRoles('owner', 'contributor', 'viewer')
  async getDatabaseStats() {
    return this.service.getDatabaseStats();
  }

  @Post('database/seed')
  @ProjectRoles('owner')
  async seedDatabase(@Body('force') force?: boolean) {
    return this.service.seedDatabase(Boolean(force));
  }

  @Get('items')
  @ProjectRoles('owner', 'contributor', 'viewer')
  async getRetractedItems(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.getRetractedItems(userId, effectiveProjectId);
  }

  @Get('stats')
  @ProjectRoles('owner', 'contributor', 'viewer')
  async getStats(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.getStats(userId, effectiveProjectId);
  }

  @Post('check-all')
  @ProjectRoles('owner', 'contributor')
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
  @ProjectRoles('owner', 'contributor')
  async syncLibrary(
    @CurrentUser('id') userId: string,
    @Body('maxDays') maxDays?: number,
    @Body('limit') limit?: number,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.service.syncLibrary(userId, effectiveProjectId, {
      maxDays: maxDays ? Number(maxDays) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('items/:itemId/check')
  @ProjectRoles('owner', 'contributor')
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
  @ProjectRoles('owner', 'contributor')
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
  @ProjectRoles('owner', 'contributor')
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
