import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { StateService } from './state.service';
import { UpdateStateDto, GetBatchStatesDto } from './dto/state.dto';

@Controller('api/v1/library/items/:itemId/state')
@UseGuards(JwtAuthGuard)
export class StateController {
  constructor(private readonly stateService: StateService) {}

  @Get()
  async getState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.stateService.getState(userId, itemId);
  }

  @Patch()
  async updateState(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateStateDto,
  ) {
    return this.stateService.updateState(userId, itemId, dto);
  }

  @Post('read')
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.stateService.markAsRead(userId, itemId);
  }
}

/**
 * Dedicated batch controller — no :itemId in path.
 * POST /api/v1/library/items/state/batch
 */
@Controller('api/v1/library/items/state')
@UseGuards(JwtAuthGuard)
export class StateBatchController {
  constructor(private readonly stateService: StateService) {}

  @Post('batch')
  async getBatchStates(
    @CurrentUser('id') userId: string,
    @Body() body: GetBatchStatesDto,
  ) {
    return this.stateService.getBatchStates(userId, body.itemIds || []);
  }
}

