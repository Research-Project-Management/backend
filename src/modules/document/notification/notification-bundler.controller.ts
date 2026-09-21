import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { NotificationBundlerService } from './notification-bundler.service';
import {
  UpdateNotificationSettingsDto,
  FlushBundleDto,
} from './dto/notification-bundler.dto';

@ApiTags('Document - Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('api/documents/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationBundlerController {
  constructor(
    private readonly bundlerService: NotificationBundlerService,
  ) {}

  @Get('bundles')
  @ApiOperation({
    summary: 'Get active pending notification bundles for current user',
  })
  async getPendingBundles(@CurrentUser('id') userId: string) {
    const bundles = await this.bundlerService.getPendingBundles(userId);
    return { bundles };
  }

  @Post('bundles/flush')
  @ApiOperation({
    summary: 'Manually flush a pending bundle immediately',
  })
  async flushBundle(
    @CurrentUser('id') userId: string,
    @Body() dto: FlushBundleDto,
  ) {
    const targetScope = dto.scopeId || dto.projectId;
    const digest = await this.bundlerService.flushBundle(userId, targetScope);
    return { digest };
  }

  @Get('digests')
  @ApiOperation({
    summary: 'Get historical notification digests for current user',
  })
  async getDigestHistory(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    const digests = await this.bundlerService.getDigestHistory(
      userId,
      isNaN(parsedLimit) ? 20 : parsedLimit,
    );
    return { digests };
  }

  @Get('settings')
  @ApiOperation({
    summary: 'Get notification bundling settings for current user',
  })
  async getSettings(@CurrentUser('id') userId: string) {
    const settings = await this.bundlerService.getUserSettings(userId);
    return { settings };
  }

  @Put('settings')
  @ApiOperation({
    summary: 'Update notification bundling settings for current user',
  })
  async updateSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNotificationSettingsDto,
  ) {
    const settings = await this.bundlerService.updateUserSettings(userId, dto);
    return { settings };
  }
}
