import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  SubscribeFeedDto,
  UpdateFeedSubDto,
  MarkItemReadDto,
  MarkAllReadDto,
  ImportOpmlDto,
} from '@/modules/library/ingestion/dto/feeds.dto';
import { FeedsService } from '@/modules/library/ingestion/services/feeds.service';

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
    const subscription = await this.feedsService.subscribe(
      userId,
      dto.url,
      dto.customTitle,
      dto.cleanupDays,
      dto.cleanupReadAfter,
      dto.cleanupUnreadAfter,
    );
    return { data: subscription };
  }

  @Patch('subscriptions/:feedId')
  @ApiOperation({ summary: 'Update feed subscription settings' })
  async updateSubscription(
    @CurrentUser('id') userId: string,
    @Param('feedId') feedId: string,
    @Body() dto: UpdateFeedSubDto,
  ) {
    const subscription = await this.feedsService.updateSubscription(
      userId,
      feedId,
      dto,
    );
    return { data: subscription };
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
