import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { PushMutationsDto, ApplyExternalSyncBatchDto } from './dto/sync.dto';
import { ExternalSyncOperation } from './ports/sync.port';

@Controller('api/v1/library/sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('pull')
  async pullDelta(
    @CurrentUser('id') userId: string,
    @Query('sinceSeq') sinceSeq?: string,
    @Query('limit') limit?: string,
  ) {
    let parsedSeq: bigint;
    let parsedLimit: number;
    try {
      parsedSeq = sinceSeq !== undefined ? BigInt(sinceSeq) : BigInt(0);
      parsedLimit = limit !== undefined ? parseInt(limit, 10) : 100;
    } catch {
      throw new BadRequestException('Invalid sync cursor or limit');
    }

    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('Invalid sync limit');
    }

    return this.syncService.pullDelta(userId, parsedSeq, parsedLimit);
  }

  @Post('push')
  async pushMutations(
    @CurrentUser('id') userId: string,
    @Body() body: PushMutationsDto,
  ) {
    if (!body || !Array.isArray(body.mutations)) {
      throw new BadRequestException(
        'Invalid payload: mutations array is required',
      );
    }

    const applied = await this.syncService.pushMutations(
      userId,
      body.mutations,
      userId,
    );

    return { applied };
  }

  @Post('batch')
  async applyBatch(
    @CurrentUser('id') userId: string,
    @Body() body: ApplyExternalSyncBatchDto,
  ) {
    if (!body || !Array.isArray(body.operations)) {
      throw new BadRequestException(
        'Invalid payload: operations array is required',
      );
    }

    return this.syncService.applyExternalSyncBatch(
      {
        userId,
        operations: body.operations as unknown as ExternalSyncOperation[],
        idempotencyKey: body.idempotencyKey,
      },
      userId,
    );
  }

  @Post('resync')
  async resync(
    @CurrentUser('id') userId: string,
  ) {
    const latestSeq = await this.syncService.getLatestSequence(userId);
    return {
      requiresFullResync: true,
      latestSeq: latestSeq.toString(),
      timestamp: new Date().toISOString(),
    };
  }
}

