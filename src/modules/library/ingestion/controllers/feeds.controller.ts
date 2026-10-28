import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { FeedsService } from '../services/feeds.service';
import {
  SubscribeFeedDto,
  UpdateFeedSubDto,
  MarkItemReadDto,
  MarkAllReadDto,
} from '../dto/feeds.dto';

export {
  SubscribeFeedDto,
  UpdateFeedSubDto,
  MarkItemReadDto,
  MarkAllReadDto,
};

@ApiTags('Library Feeds')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/feeds')
@UseGuards(JwtAuthGuard)
export class FeedsController {
  constructor(private readonly feedsService: FeedsService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: 'Get current user subscribed academic RSS/Atom feeds' })
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

  @Get(':feedId/items')
  @ApiOperation({ summary: 'Get items/articles for a subscribed feed' })
  async getFeedItems(
    @CurrentUser('id') userId: string,
    @Param('feedId') feedId: string,
    @Query('readStatus') readStatus?: 'read' | 'unread' | 'all',
    @Query('limit') limit?: number,
  ) {
    const items = await this.feedsService.getFeedItems(userId, feedId, {
      readStatus,
      limit: limit ? Number(limit) : undefined,
    });
    return { data: items };
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
