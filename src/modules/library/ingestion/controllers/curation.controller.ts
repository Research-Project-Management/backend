import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Optional, Delete, ForbiddenException, HttpCode, HttpStatus } from '@nestjs/common';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { QualityService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { MergeDuplicatesDto, BatchMergeDuplicatesDto, DismissDuplicatesDto, UpdateReviewCaseStatusDto, FlagRetractionDto, BatchCheckRetractionDto, SyncRetractionDto } from '@/modules/library/ingestion/dto/ingestion.dto';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { FeedsService } from '../services/feeds.service';
import { SubscribeFeedDto, UpdateFeedSubDto, MarkItemReadDto, MarkAllReadDto, ImportOpmlDto } from '../dto/ingestion.dto';

@ApiTags('Library Curation')
@ApiBearerAuth()
@Controller([
  'api/v1/library/curation',
  'api/v1/projects/:projectId/library/curation',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class CurationController {
  constructor(
    private readonly duplicateDetector: DuplicateDetectorService,
    private readonly duplicateMerger: DuplicateMergerService,
    private readonly qualityService: QualityService,
    @Optional() private readonly ingestionService?: IngestionService,
  ) {}

  @Get('duplicates')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getDuplicates(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.duplicateDetector.detectDuplicates(userId, effectiveProjectId);
  }

  /**
   * Zotero-Compliant Human-in-the-Loop Merge:
   * Merging requires explicit review and confirmation from the user.
   * Automated batch merging has been decommissioned to guarantee 0% data corruption risk.
   */
  @Post('merge')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async mergeDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: MergeDuplicatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto.projectId;
    return this.duplicateMerger.mergeDuplicates(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  @Post('merge-batch')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async mergeDuplicatesBatch(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchMergeDuplicatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.duplicateMerger.mergeDuplicatesBatch(
      userId,
      dto?.merges || [],
      effectiveProjectId,
    );
  }

  @Post('duplicates/dismiss')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async dismissDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: DismissDuplicatesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.duplicateDetector.dismissDuplicates(
      userId,
      dto.itemIds,
      effectiveProjectId,
    );
  }

  @Get(['quality', 'integrity'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getQualityAudit(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.qualityService.getQualityAudit(userId, effectiveProjectId);
  }

  @Get('review-cases')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getReviewCases(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!this.ingestionService) {
      return [];
    }
    const effectiveProjectId = paramProjectId || queryProjectId;
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.ingestionService.findReviewCases(
      { userId, projectId: effectiveProjectId },
      {
        status,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      },
    );
  }

  @Patch('review-cases/:id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async updateReviewCaseStatus(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReviewCaseStatusDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!this.ingestionService) {
      return null;
    }
    const effectiveProjectId =
      paramProjectId || queryProjectId || dto?.projectId;
    return this.ingestionService.updateReviewCaseStatus(
      { userId, projectId: effectiveProjectId },
      id,
      dto.status,
    );
  }
}

@ApiTags('Library Retraction')
@ApiBearerAuth()
@Controller([
  'api/v1/library/retraction',
  'api/v1/projects/:projectId/library/retraction',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class RetractionController {
  private lastForceSeedAt = 0;
  private static readonly FORCE_SEED_COOLDOWN_MS = 15 * 60 * 1000;

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
    const allowForce =
      Boolean(force) &&
      (role === 'superadmin' || role === 'system') &&
      Date.now() - this.lastForceSeedAt >
        RetractionController.FORCE_SEED_COOLDOWN_MS;
    if (allowForce) {
      this.lastForceSeedAt = Date.now();
    }
    return this.service.seedDatabase(allowForce);
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

export {
  SubscribeFeedDto,
  UpdateFeedSubDto,
  MarkItemReadDto,
  MarkAllReadDto,
  ImportOpmlDto,
};

@ApiTags('Library Feeds')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/feeds')
@UseGuards(JwtAuthGuard)
export class FeedsController {
  constructor(private readonly feedsService: FeedsService) {}

  @Get('subscriptions')
  @ApiOperation({
    summary: 'Get current user subscribed academic RSS/Atom feeds',
  })
  async getSubscriptions(@CurrentUser('id') userId: string) {
    const subscriptions = await this.feedsService.getSubscriptions(userId);
    return { data: subscriptions };
  }

  @Post('subscriptions')
  @ApiOperation({ summary: 'Subscribe to an academic RSS/Atom feed' })
  async subscribe(
    @CurrentUser('id') userId: string,
    @Body() dto: SubscribeFeedDto,
  ) {
    const sub = await this.feedsService.subscribe(
      userId,
      dto.url,
      dto.customTitle,
      dto.cleanupDays,
      dto.cleanupReadAfter,
      dto.cleanupUnreadAfter,
    );
    return { data: sub };
  }

  @Patch('subscriptions/:feedId')
  @ApiOperation({ summary: 'Update feed subscription settings' })
  async updateSubscription(
    @CurrentUser('id') userId: string,
    @Param('feedId') feedId: string,
    @Body() dto: UpdateFeedSubDto,
  ) {
    const sub = await this.feedsService.updateSubscription(userId, feedId, dto);
    return { data: sub };
  }

  @Delete('subscriptions/:feedId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unsubscribe from a feed' })
  async unsubscribe(
    @CurrentUser('id') userId: string,
    @Param('feedId') feedId: string,
  ) {
    await this.feedsService.unsubscribe(userId, feedId);
  }

  @Get('opml/export')
  @ApiOperation({ summary: 'Export subscribed feeds as OPML 2.0 XML' })
  async exportOpml(@CurrentUser('id') userId: string) {
    const opmlXml = await this.feedsService.exportOpml(userId);
    return { data: { opmlXml }, opmlXml };
  }

  @Post('opml/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Import RSS/Atom feeds from OPML 2.0 XML' })
  async importOpml(
    @CurrentUser('id') userId: string,
    @Body() dto: ImportOpmlDto,
  ) {
    const res = await this.feedsService.importOpml(userId, dto?.opmlXml || '');
    return { data: res, ...res };
  }

  @Get(':feedId/items')
  @ApiOperation({ summary: 'Get items/articles for a subscribed feed' })
  async getFeedItems(
    @CurrentUser('id') userId: string,
    @Param('feedId') feedId: string,
    @Query('readStatus') readStatus?: 'read' | 'unread' | 'all',
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
    @Query('page') page?: number,
    @Query('search') search?: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    const items = await this.feedsService.getFeedItems(userId, feedId, {
      readStatus,
      limit: limit ? Number(limit) : undefined,
      cursor,
      page: page ? Number(page) : undefined,
      search,
      forceRefresh: forceRefresh === 'true',
    });
    const meta = items._paginationMeta ?? {
      hasNextPage: false,
      nextCursor: null,
      limit: limit ? Number(limit) : 50,
    };
    return {
      data: items,
      meta,
      hasNextPage: meta.hasNextPage,
      nextCursor: meta.nextCursor,
    };
  }

  @Post(':feedId/mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all items in a subscribed feed as read' })
  async markFeedAllRead(
    @CurrentUser('id') userId: string,
    @Param('feedId') feedId: string,
  ) {
    const res = await this.feedsService.markFeedAllRead(userId, feedId);
    return { success: true, ...res };
  }

  @Post('items/:itemId/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle or set read status for a feed item' })
  async markItemRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: MarkItemReadDto,
  ) {
    await this.feedsService.markItemRead(userId, itemId, dto.isRead ?? true);
    return { success: true };
  }

  @Post('items/mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark multiple feed items as read in bulk' })
  async markAllRead(
    @CurrentUser('id') userId: string,
    @Body() dto: MarkAllReadDto,
  ) {
    await this.feedsService.markAllRead(userId, dto.itemIds || []);
    return { success: true };
  }
}
