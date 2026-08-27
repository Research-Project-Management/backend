import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TranslationService } from './translation.service';
import { JobsService as TranslationJobService } from './jobs.service';
import { IngestDocumentDto, BatchIngestDto } from './dto/translation.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Translation')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class TranslationController {
  constructor(
    private readonly translationService: TranslationService,
    private readonly jobService: TranslationJobService,
  ) {}

  @Post(['workspace/:workspaceId/library/ingest', 'library/ingest'])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Ingest an academic document from any source (DOI, BibTeX, PDF, Storage) into library',
  })
  async ingest(
    @Param('workspaceId') workspaceId: string | undefined,
    @CurrentUser('id') userId: string,
    @Body() dto: IngestDocumentDto,
  ) {
    if (workspaceId) dto.workspaceId = workspaceId;
    return this.translationService.ingest(userId, dto);
  }

  @Post(['workspace/:workspaceId/library/ingest/batch', 'library/ingest/batch'])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Batch ingest multiple academic documents with parallel resolution',
  })
  async batchIngest(
    @Param('workspaceId') workspaceId: string | undefined,
    @CurrentUser('id') userId: string,
    @Body() dto: BatchIngestDto,
  ) {
    if (workspaceId) {
      dto.items = dto.items.map((item) => ({ ...item, workspaceId }));
    }
    return this.translationService.batchIngest(userId, dto);
  }

  @Post([
    'workspace/:workspaceId/library/ingest/batch-async',
    'library/ingest/batch-async',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Enqueues an asynchronous batch ingestion job (non-blocking) and returns a trackable Job ID',
  })
  async createAsyncBatchJob(
    @Param('workspaceId') workspaceId: string | undefined,
    @CurrentUser('id') userId: string,
    @Body() dto: BatchIngestDto,
  ) {
    if (workspaceId) {
      dto.items = dto.items.map((item) => ({ ...item, workspaceId }));
    }
    return this.jobService.createAsyncBatchJob(userId, dto);
  }

  @Get([
    'workspace/:workspaceId/library/ingest/jobs/:jobId',
    'library/ingest/jobs/:jobId',
  ])
  @ApiOperation({
    summary: 'Poll status and results of an async batch ingestion job',
  })
  async getJobStatus(
    @Param('jobId') jobId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.jobService.getJobStatus(jobId, userId);
  }

  @Get(['workspace/:workspaceId/library/ingest/jobs', 'library/ingest/jobs'])
  @ApiOperation({ summary: 'List all async ingestion jobs for current user' })
  listJobs(@CurrentUser('id') userId: string) {
    return this.jobService.listUserJobs(userId);
  }

  @Delete([
    'workspace/:workspaceId/library/ingest/jobs/:jobId',
    'library/ingest/jobs/:jobId',
  ])
  @ApiOperation({ summary: 'Cancel or dismiss an async ingestion job' })
  async cancelJob(
    @Param('jobId') jobId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.jobService.cancelJob(jobId, userId);
  }
}

export { TranslationController as IngestionController };
