import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { RetractionService } from './retraction.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import {
  FlagRetractionDto,
  BatchCheckRetractionDto,
} from './dto/retraction.dto';

@Controller('api/v1/library/retraction')
@UseGuards(JwtAuthGuard)
export class RetractionController {
  constructor(private readonly service: RetractionService) {}

  @Get('items')
  async getRetractedItems(@CurrentUser('id') userId: string) {
    return this.service.getRetractedItems(userId);
  }

  @Get('stats')
  async getStats(@CurrentUser('id') userId: string) {
    return this.service.getStats(userId);
  }

  @Post('check-all')
  async checkLibrary(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchCheckRetractionDto,
  ) {
    return this.service.checkLibrary(userId, dto);
  }

  @Post('items/:itemId/check')
  async checkItem(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.checkItem(userId, itemId);
  }

  @Post('items/:itemId/flag')
  async setManualFlag(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: FlagRetractionDto,
  ) {
    return this.service.setManualFlag(userId, itemId, dto);
  }

  @Delete('items/:itemId/flag')
  async removeManualFlag(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.removeManualFlag(userId, itemId);
  }
}
