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
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import {
  CreateNotificationDto,
  QueryNotificationsDto,
  ParseMentionsDto,
} from './dto/notification.dto';

@ApiTags('Notifications')
@Controller(['notifications', 'api/notifications', 'manuscripts/notifications'])
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  private extractUserId(req: any): string {
    return req?.user?.id || req?.headers?.['x-user-id'] || 'anonymous-user';
  }

  @Get()
  @ApiOperation({ summary: 'Get current user notifications inbox' })
  @ApiResponse({ status: 200, description: 'List of user notifications' })
  async getNotifications(@Req() req: any, @Query() query: QueryNotificationsDto) {
    const userId = this.extractUserId(req);
    const notifications = await this.notificationsService.getUserNotifications(userId, {
      isRead: query.isRead,
      type: query.type,
      limit: query.limit,
      offset: query.offset,
    });
    return notifications.map((n) => n.toPlain());
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count for badge counter' })
  @ApiResponse({ status: 200, description: 'Unread count' })
  async getUnreadCount(@Req() req: any) {
    const userId = this.extractUserId(req);
    const count = await this.notificationsService.getUnreadCount(userId);
    return { count };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new notification' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  async createNotification(@Body() dto: CreateNotificationDto, @Req() req: any) {
    const userId = dto.userId || this.extractUserId(req);
    const notification = await this.notificationsService.createNotification({
      ...dto,
      userId,
      type: dto.type as any,
    });
    return notification.toPlain();
  }

  @Post('parse-mentions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extract @mentions from text and dispatch notifications' })
  @ApiResponse({ status: 200, description: 'Parsed tokens and dispatched notifications' })
  async parseMentions(@Body() dto: ParseMentionsDto) {
    const result = await this.notificationsService.parseAndNotifyMentions(dto);
    return {
      tokens: result.tokens,
      dispatchedNotifications: result.dispatchedNotifications.map((n) => n.toPlain()),
    };
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  async markAsRead(@Param('id') id: string, @Req() req: any) {
    const userId = this.extractUserId(req);
    const success = await this.notificationsService.markAsRead(id, userId);
    return { success };
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read for current user' })
  @ApiResponse({ status: 200, description: 'Number of notifications marked as read' })
  async markAllAsRead(@Req() req: any) {
    const userId = this.extractUserId(req);
    const count = await this.notificationsService.markAllAsRead(userId);
    return { count };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  async deleteNotification(@Param('id') id: string, @Req() req: any) {
    const userId = this.extractUserId(req);
    const success = await this.notificationsService.deleteById(id, userId);
    return { success };
  }

  @Delete('key/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete notifications by unique key' })
  @ApiResponse({ status: 200, description: 'Count of deleted notifications' })
  async deleteByKey(@Param('key') key: string, @Req() req: any) {
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
@Controller(['manuscripts/v1/notifications-compat', 'v1/notifications-compat', 'notifications/v1/compat'])
export class OverleafNotificationsParityController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('user/:user_id')
  async getUserNotifications(@Param('user_id') userId: string) {
    const items = await this.notificationsService.getUserNotifications(userId);
    return items.map((n) => n.toPlain());
  }

  @Post('user/:user_id')
  @HttpCode(HttpStatus.OK)
  async addNotification(@Param('user_id') userId: string, @Body() body: any) {
    await this.notificationsService.createNotification({
      userId,
      key: body.key,
      templateKey: body.templateKey,
      type: body.type,
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
    @Param('notification_id') notificationId: string
  ) {
    await this.notificationsService.deleteById(notificationId, userId);
    return { status: 'ok' };
  }

  @Delete('user/:user_id')
  @HttpCode(HttpStatus.OK)
  async removeNotificationKey(
    @Param('user_id') userId: string,
    @Body('key') key: string
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
