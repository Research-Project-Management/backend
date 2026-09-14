import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { UpdateProfileDto } from './dto/profile.dto';
import { ChangePasswordDto } from './dto/password.dto';
import { UpdateUserSettingsDto } from './dto/settings.dto';
import { JwtAuthGuard } from '../authn/guards/auth.guard';
import { CurrentUser } from '../authn/decorators/user.decorator';
import {
  MessageResponseDto,
  UserSummaryResponseDto,
} from '../authn/dto/response.dto';

@ApiTags('User & Account')
@ApiBearerAuth('JWT-auth')
@Controller()
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get(['api/users/me', 'auth/me', 'auth/user'])
  @ApiOperation({ summary: 'Get current user profile and account preferences' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
    type: UserSummaryResponseDto,
  })
  async getMe(@CurrentUser('id') userId: string) {
    return this.userService.getMe(userId);
  }

  @Put(['api/users/profile', 'auth/profile'])
  @ApiOperation({ summary: 'Update current user profile (name, avatar)' })
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

  @Get('api/users/settings')
  @ApiOperation({ summary: 'Get current user account preferences & settings' })
  async getSettings(@CurrentUser('id') userId: string) {
    return this.userService.getSettings(userId);
  }

  @Put('api/users/settings')
  @ApiOperation({
    summary: 'Update current user account preferences & settings',
  })
  async updateSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateUserSettingsDto,
  ) {
    return this.userService.updateSettings(userId, dto);
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
  @ApiOperation({
    summary: 'Search users by name or email (for project invitations)',
  })
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

  @Get(['api/search', 'api/users/me/search'])
  @ApiOperation({
    summary:
      'Global search across user entities (projects, work items, papers, pages, files, stickies)',
  })
  async searchUserEntities(
    @CurrentUser('id') userId: string,
    @Query('q') query: string,
  ) {
    return this.userService.searchAll(userId, query || '');
  }

  @Get('api/users/me/stats')
  @ApiOperation({
    summary: 'Get current user dashboard resource usage and statistics',
  })
  async getMyStats(@CurrentUser('id') userId: string) {
    return this.userService.getUserStats(userId);
  }

  @Get('api/users/me/identities')
  @ApiOperation({
    summary:
      'Get list of linked third-party identities (Google, GitHub, ORCID)',
  })
  async getIdentities(@CurrentUser('id') userId: string) {
    return this.userService.getIdentities(userId);
  }

  @Delete('api/users/me/identities/:provider')
  @ApiOperation({ summary: 'Unlink a third-party identity from user account' })
  async unlinkIdentity(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: AuthProvider,
  ) {
    return this.userService.unlinkIdentity(userId, provider);
  }

  @Delete(['api/users/me', 'auth/me'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Permanently delete current user account' })
  @ApiResponse({ status: 200, description: 'Account deleted' })
  async deleteMe(@CurrentUser('id') userId: string) {
    return this.userService.deleteMe(userId);
  }
}
