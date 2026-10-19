import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { NotificationsService } from './notifications.service';
import { ReviewNotificationBundlingUseCase } from './core/use-cases/review-notification-bundling.use-case';
import {
  CreateNotificationDto,
  QueryNotificationsDto,
  ParseMentionsDto,
} from './dto/notification.dto';
import { NotificationTypeString } from './core/domain/value-objects/notification-type.vo';

@ApiTags('Notifications')
@Controller([
  'notifications',
  'api/notifications',
  'manuscripts/notifications',
  'api/documents/notifications',
  'documents/notifications',
])
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly bundling: ReviewNotificationBundlingUseCase,
  ) {}

  @Get('bundles')
  @ApiOperation({
    summary: 'Get pending review notification bundles (unread, per project)',
  })
  async getPendingBundles(@CurrentUser('id') userId: string) {
    // Elapsed windows are collapsed into digests before listing.
    await this.bundling.flushDue(userId);
    return { bundles: await this.bundling.getPendingBundles(userId) };
  }

  @Post('bundles/flush')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Flush pending review notifications into a digest' })
  async flushBundle(
    @CurrentUser('id') userId: string,
    @Body() body: { scopeId?: string; projectId?: string },
  ) {
    const digest = await this.bundling.flush(
      userId,
      body?.projectId || body?.scopeId || undefined,
    );
    return { digest };
  }

  @Get('digests')
  @ApiOperation({ summary: 'Get digest notification history' })
  async getDigestHistory(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit) || 20;
    return { digests: await this.bundling.listDigests(userId, n) };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get review notification bundling settings' })
  async getSettings(@CurrentUser('id') userId: string) {
    return { settings: await this.bundling.getSettings(userId) };
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update review notification bundling settings' })
  async updateSettings(
    @CurrentUser('id') userId: string,
    @Body() body: { enabled?: boolean; windowMinutes?: number },
  ) {
    const patch: { enabled?: boolean; windowMinutes?: number } = {};
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
    if (body?.windowMinutes !== undefined) {
      patch.windowMinutes = Number(body.windowMinutes);
    }
    return { settings: await this.bundling.updateSettings(userId, patch) };
  }

  private extractUserId(userOrReq: unknown): string {
    if (typeof userOrReq === 'string') return userOrReq;
    const obj = userOrReq as Record<string, unknown> | undefined;
    const user = obj?.user as { id?: string } | undefined;
    return user?.id || (obj?.id as string) || '';
  }

  @Get()
  @ApiOperation({ summary: 'Get current user notifications inbox' })
  @ApiResponse({ status: 200, description: 'List of user notifications' })
  async getNotifications(
    @CurrentUser('id') userId: string,
    @Query() query?: QueryNotificationsDto,
  ) {
    const resolvedId = this.extractUserId(userId);
    const notifications = await this.notificationsService.getUserNotifications(
      resolvedId,
      {
        isRead: query?.isRead,
        type: query?.type,
        limit: query?.limit,
        offset: query?.offset,
      },
    );
    return notifications.map((n) => n.toPlain());
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count for badge counter' })
  @ApiResponse({ status: 200, description: 'Unread count' })
  async getUnreadCount(@CurrentUser('id') userId: string) {
    const resolvedId = this.extractUserId(userId);
    const count = await this.notificationsService.getUnreadCount(resolvedId);
    return { count };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new notification' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  async createNotification(
    @Body() dto: CreateNotificationDto,
    @CurrentUser('id') currentUserId: string,
  ) {
    const resolvedId = dto.userId || this.extractUserId(currentUserId);
    const notification = await this.notificationsService.createNotification({
      ...dto,
      userId: resolvedId,
      type: dto.type as NotificationTypeString | undefined,
    });
    return notification.toPlain();
  }

  @Post('parse-mentions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extract @mentions from text and dispatch notifications',
  })
  @ApiResponse({
    status: 200,
    description: 'Parsed tokens and dispatched notifications',
  })
  async parseMentions(@Body() dto: ParseMentionsDto) {
    const result = await this.notificationsService.parseAndNotifyMentions(dto);
    return {
      tokens: result.tokens,
      dispatchedNotifications: result.dispatchedNotifications.map(
        (n: { toPlain: () => unknown }) => n.toPlain(),
      ),
    };
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  async markAsRead(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const resolvedId = this.extractUserId(userId);
    const success = await this.notificationsService.markAsRead(id, resolvedId);
    return { success };
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read for current user' })
  @ApiResponse({
    status: 200,
    description: 'Number of notifications marked as read',
  })
  async markAllAsRead(@CurrentUser('id') userId: string) {
    const resolvedId = this.extractUserId(userId);
    const count = await this.notificationsService.markAllAsRead(resolvedId);
    return { count };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  async deleteNotification(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const resolvedId = this.extractUserId(userId);
    const success = await this.notificationsService.deleteById(id, resolvedId);
    return { success };
  }

  @Delete('key/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete notifications by unique key' })
  @ApiResponse({ status: 200, description: 'Count of deleted notifications' })
  async deleteByKey(
    @Param('key') key: string,
    @CurrentUser('id') userId: string,
  ) {
    const resolvedId = this.extractUserId(userId);
    const count = await this.notificationsService.deleteByKey(key, resolvedId);
    return { count };
  }
}

/**
 * 1:1 Legacy Overleaf Notification API Controller
 */
@ApiTags('Notifications - Overleaf Parity')
@Controller('user')
export class OverleafNotificationsParityController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post(':user_id')
  async addNotification(
    @Param('user_id') userId: string,
    @Body()
    dto: {
      key?: string;
      templateKey: string;
      messageOpts?: Record<string, unknown>;
    },
  ) {
    await this.notificationsService.createNotification({
      userId,
      key: dto.key,
      templateKey: dto.templateKey,
      messageOpts: dto.messageOpts,
    });
    return { status: 'ok' };
  }

  @Get(':user_id')
  async getUserNotifications(@Param('user_id') userId: string) {
    const list = await this.notificationsService.getUserNotifications(userId);
    return list.map((n) => n.toPlain());
  }

  @Delete(':user_id/notification/:notification_id')
  async removeNotificationId(
    @Param('user_id') userId: string,
    @Param('notification_id') notificationId: string,
  ) {
    await this.notificationsService.deleteById(notificationId, userId);
    return { status: 'ok' };
  }

  @Delete(':user_id/notification/key/:key')
  async removeNotificationKey(
    @Param('user_id') userId: string,
    @Param('key') key: string,
  ) {
    await this.notificationsService.deleteByKey(key, userId);
    return { status: 'ok' };
  }

  @Delete('notifications/key/:key')
  async removeNotificationByKeyOnly(@Param('key') key: string) {
    await this.notificationsService.deleteByKey(key);
    return { status: 'ok' };
  }
}

