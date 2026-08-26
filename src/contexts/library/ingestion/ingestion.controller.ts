import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { IngestionService } from './ingestion.service';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
} from './dto/ingestion.dto';

@Controller('api/v1/workspaces/:workspaceId/library/ingestion')
@UseGuards(JwtAuthGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('start')
  async startRun(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: StartIngestionDto,
  ) {
    const run = await this.ingestionService.startRun(
      workspaceId,
      userId || 'system',
      dto,
    );
    return {
      success: true,
      data: run,
    };
  }

  @Get('status/:runId')
  async getStatus(@Param('runId') runId: string) {
    const status = await this.ingestionService.getRunStatus(runId);
    return {
      success: true,
      data: status,
    };
  }

  @Post('doi')
  async ingestDoi(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: IngestDoiDto,
  ) {
    const item = await this.ingestionService.ingestDoi(
      workspaceId,
      userId || 'system',
      dto,
    );
    return {
      success: true,
      data: item,
    };
  }

  @Post('bibtex')
  async ingestBibtex(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: IngestBibtexDto,
  ) {
    const item = await this.ingestionService.ingestBibtex(
      workspaceId,
      userId || 'system',
      dto,
    );
    return {
      success: true,
      data: item,
    };
  }
}
