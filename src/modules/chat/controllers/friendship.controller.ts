import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '@/modules/identity/auth';
import { FriendshipService } from '../services/friendship.service';

@ApiTags('Chat')
@ApiBearerAuth('JWT-auth')
@Controller(['api/chat/friends', 'chat/friends', 'api/friends', 'friends'])
@UseGuards(AuthGuard)
export class FriendshipController {
  constructor(private readonly friendshipService: FriendshipService) {}

  @Get()
  async getFriends(@CurrentUser('id') userId: string) {
    return this.friendshipService.getFriends(userId);
  }

  @Get('requests')
  async getPendingRequests(@CurrentUser('id') userId: string) {
    return this.friendshipService.getPendingRequests(userId);
  }

  @Get('search')
  async searchUsers(
    @CurrentUser('id') userId: string,
    @Query('q') query?: string,
  ) {
    return this.friendshipService.searchUsers(userId, query);
  }

  @Post('request')
  async sendRequestBody(
    @CurrentUser('id') userId: string,
    @Body('targetUserId') targetUserId: string,
  ) {
    if (!targetUserId) {
      throw new BadRequestException('targetUserId is required');
    }
    return this.friendshipService.sendRequest(userId, targetUserId);
  }

  @Post('request/:targetUserId')
  async sendRequest(
    @CurrentUser('id') userId: string,
    @Param('targetUserId') targetUserId: string,
  ) {
    return this.friendshipService.sendRequest(userId, targetUserId);
  }

  @Post('requests/:requestId/respond')
  async respondRequest(
    @CurrentUser('id') userId: string,
    @Param('requestId') requestId: string,
    @Body('action') action: 'accept' | 'decline',
  ) {
    if (action === 'accept') {
      return this.friendshipService.acceptRequest(userId, requestId);
    } else if (action === 'decline') {
      return this.friendshipService.declineRequest(userId, requestId);
    }
    throw new BadRequestException('Invalid action. Must be accept or decline');
  }

  @Put('requests/:requestId/accept')
  async acceptRequest(
    @CurrentUser('id') userId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.friendshipService.acceptRequest(userId, requestId);
  }

  @Put('requests/:requestId/decline')
  async declineRequest(
    @CurrentUser('id') userId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.friendshipService.declineRequest(userId, requestId);
  }
}
