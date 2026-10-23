import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '@/modules/identity/auth';
import { FriendshipService } from '../services/friendship.service';

@ApiTags('Chat')
@ApiBearerAuth('JWT-auth')
@Controller('friends')
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

  @Post('request/:targetUserId')
  async sendRequest(
    @CurrentUser('id') userId: string,
    @Param('targetUserId') targetUserId: string,
  ) {
    return this.friendshipService.sendRequest(userId, targetUserId);
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
