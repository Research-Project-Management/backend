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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { AuthenticatedRequest } from '@/core';
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
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly bundling: ReviewNotificationBundlingUseCase,
  ) {}

  private extractUserId(req?: AuthenticatedRequest): string {
    const rawHeader = req?.headers?.['x-user-id'];
    const headerUserId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    return req?.user?.id || headerUserId || 'anonymous-user';
  }

  @Get('bundles')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get pending review notification bundles (unread, per project)',
  })
  async getPendingBundles(@CurrentUser('id') userId: string) {
    // Elapsed windows are collapsed into digests before listing.
    await this.bundling.flushDue(userId);
    return { bundles: await this.bundling.getPendingBundles(userId) };
  }

  @Post('bundles/flush')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get digest notification history' })
  async getDigestHistory(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit) || 20;
    return { digests: await this.bundling.listDigests(userId, n) };
  }

  @Get('settings')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get review notification bundling settings' })
  async getSettings(@CurrentUser('id') userId: string) {
    return { settings: await this.bundling.getSettings(userId) };
  }

  @Put('settings')
  @UseGuards(JwtAuthGuard)
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

  @Get()
  @ApiOperation({ summary: 'Get current user notifications inbox' })
  @ApiResponse({ status: 200, description: 'List of user notifications' })
  async getNotifications(
    @Req() req: AuthenticatedRequest,
    @Query() query: QueryNotificationsDto,
  ) {
    const userId = this.extractUserId(req);
    const notifications = await this.notificationsService.getUserNotifications(
      userId,
      {
        isRead: query.isRead,
        type: query.type,
        limit: query.limit,
        offset: query.offset,
      },
    );
    return notifications.map((n) => n.toPlain());
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count for badge counter' })
  @ApiResponse({ status: 200, description: 'Unread count' })
  async getUnreadCount(@Req() req: AuthenticatedRequest) {
    const userId = this.extractUserId(req);
    const count = await this.notificationsService.getUnreadCount(userId);
    return { count };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new notification' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  async createNotification(
    @Body() dto: CreateNotificationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = dto.userId || this.extractUserId(req);
    const notification = await this.notificationsService.createNotification({
      ...dto,
      userId,
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
      dispatchedNotifications: result.dispatchedNotifications.map((n) =>
        n.toPlain(),
      ),
    };
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  async markAsRead(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = this.extractUserId(req);
    const success = await this.notificationsService.markAsRead(id, userId);
    return { success };
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read for current user' })
  @ApiResponse({
    status: 200,
    description: 'Number of notifications marked as read',
  })
  async markAllAsRead(@Req() req: AuthenticatedRequest) {
    const userId = this.extractUserId(req);
    const count = await this.notificationsService.markAllAsRead(userId);
    return { count };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  async deleteNotification(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = this.extractUserId(req);
    const success = await this.notificationsService.deleteById(id, userId);
    return { success };
  }

  @Delete('key/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete notifications by unique key' })
  @ApiResponse({ status: 200, description: 'Count of deleted notifications' })
  async deleteByKey(
    @Param('key') key: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = this.extractUserId(req);
    const count = await this.notificationsService.deleteByKey(key, userId);
    return { count };
  }
}

/**
 * Overleaf-parity HTTP Controller matching exact routes from services/notifications/app.js:
 * - GET    /user/:user_id
 * - POST   /user/:user_id
 * - DELETE /user/:user_id/notification/:notification_id
 * - DELETE /user/:user_id
 * - DELETE /key/:key
 */
@ApiTags('Notifications - Overleaf Parity')
@Controller([
  'manuscripts/v1/notifications-compat',
  'v1/notifications-compat',
  'notifications/v1/compat',
])
export class OverleafNotificationsParityController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('user/:user_id')
  async getUserNotifications(@Param('user_id') userId: string) {
    const items = await this.notificationsService.getUserNotifications(userId);
    return items.map((n) => n.toPlain());
  }

  @Post('user/:user_id')
  @HttpCode(HttpStatus.OK)
  async addNotification(
    @Param('user_id') userId: string,
    @Body() body: Partial<CreateNotificationDto> & { expires?: string | Date },
  ) {
    await this.notificationsService.createNotification({
      userId,
      key: body.key,
      templateKey: body.templateKey ?? 'notification',
      type: body.type as NotificationTypeString | undefined,
      messageOpts: body.messageOpts,
      expiresAt: body.expires,
      forceCreate: body.forceCreate,
    });
    return { status: 'ok' };
  }

  @Delete('user/:user_id/notification/:notification_id')
  @HttpCode(HttpStatus.OK)
  async removeNotificationId(
    @Param('user_id') userId: string,
    @Param('notification_id') notificationId: string,
  ) {
    await this.notificationsService.deleteById(notificationId, userId);
    return { status: 'ok' };
  }

  @Delete('user/:user_id')
  @HttpCode(HttpStatus.OK)
  async removeNotificationKey(
    @Param('user_id') userId: string,
    @Body('key') key: string,
  ) {
    if (key) {
      await this.notificationsService.deleteByKey(key, userId);
    }
    return { status: 'ok' };
  }

  @Delete('key/:key')
  @HttpCode(HttpStatus.OK)
  async removeNotificationByKeyOnly(@Param('key') key: string) {
    await this.notificationsService.deleteByKey(key);
    return { status: 'ok' };
  }
}
