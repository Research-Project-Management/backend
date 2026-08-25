import { Controller, Get, Put, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserService } from './user.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../authn/guards/jwt-auth.guard';
import { CurrentUser } from '../authn/decorators/current-user.decorator';
import { MessageResponseDto, UserSummaryResponseDto } from '../authn/dto/authn-response.dto';

@ApiTags('Identity')
@ApiBearerAuth('JWT-auth')
@Controller()
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get(['api/users/me', 'auth/me', 'auth/user'])
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
    type: UserSummaryResponseDto,
  })
  async getMe(@CurrentUser('id') userId: string) {
    return this.userService.getMe(userId);
  }

  @Put(['api/users/profile', 'auth/profile'])
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully',
    type: UserSummaryResponseDto,
  })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.userService.updateProfile(userId, dto);
  }

  @Put(['api/users/change-password', 'auth/change-password'])
  @ApiOperation({ summary: 'Change current user password' })
  @ApiResponse({
    status: 200,
    description: 'Password updated successfully',
    type: MessageResponseDto,
  })
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.userService.changePassword(userId, dto);
  }

  @Get(['api/users/search', 'auth/search-users'])
  @ApiOperation({ summary: 'Search users by name or email' })
  @ApiResponse({
    status: 200,
    description: 'List of matching users',
    type: [UserSummaryResponseDto],
  })
  async searchUsers(
    @Query('query') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.userService.searchUsers(query, userId);
  }
}
