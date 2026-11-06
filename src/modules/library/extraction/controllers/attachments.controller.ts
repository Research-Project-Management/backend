import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, NotFoundException, HttpStatus, HttpCode, Res, Optional, ParseUUIDPipe, Req, BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { type FastifyReply, FastifyRequest } from 'fastify';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles, ProjectRole } from '@/modules/project/access';
import { CreateAttachmentDto, RenameAttachmentDto, BatchRenameAttachmentsDto, CaptureSnapshotDto, BenchmarkPayloadDto } from '@/modules/library/extraction/dto/annotations.dto';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import { WebSnapshotService } from '@/modules/library/extraction/services/web-snapshot.service';
import { normalizeProjectScopeId, EXTRACTION_FACADE, IExtractionFacade } from '@/modules/library/core';
import { Inject } from '@nestjs/common';

// Services

/**
 * Unified Library Attachments Controller (`/api/v1/library` and `/api/v1/projects/:projectId/library`).
 * Enforces JwtAuthGuard and ProjectAccessGuard (which allows user-scoped routes without :projectId).
 */
@ApiTags('Library Attachments')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class AttachmentController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    @Optional()
    private readonly webSnapshotService?: WebSnapshotService,
  ) {}

  @Get('attachments/:attachmentId/thumbnail')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get thumbnail image for an attachment' })
  async getAttachmentThumbnail(
    @CurrentUser('id') userId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    const thumbnail = await this.attachmentsService.getThumbnail(
      userId,
      attachmentId,
      projectId,
    );

    res.header('Content-Type', thumbnail?.mimeType || 'image/webp');
    res.header('Cache-Control', 'private, max-age=86400');
    res.header('Vary', 'Authorization');
    return res.send(thumbnail?.buffer || Buffer.from(''));
  }

  @Get('items/:itemId/attachments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all attachments for a library item' })
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.attachmentsService.getItemAttachments(
      userId,
      itemId,
      paramProjectId || queryProjectId,
    );
  }

  @Get(['items/:itemId/attachments/:attachmentId', 'attachments/:attachmentId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get attachment details by ID' })
  async getItemAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Param('itemId', new ParseUUIDPipe({ optional: true })) itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    return this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Post(['items/:itemId/attachments', 'attachments'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and associate a new attachment' })
  async createAttachment(
    @CurrentUser('id') userId: string,
    @Param('itemId', new ParseUUIDPipe({ optional: true })) paramItemId: string | undefined,
    @Body() dto: CreateAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    const itemId = paramItemId || dto.itemId;
    if (!itemId) {
      throw new NotFoundException(
        'Target itemId is required for attachment creation',
      );
    }

    return this.attachmentsService.createAttachment(
      {
        ...dto,
        userId,
        itemId,
      },
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/:attachmentId/re-extract')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger re-extraction on an attachment' })
  async reExtractAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.attachmentsService.reExtractAttachment(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Delete('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment' })
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.attachmentsService.deleteAttachment(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Post([
    'attachments/:attachmentId/set-primary',
    'items/:itemId/attachments/:attachmentId/set-primary',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set attachment as primary PDF for item' })
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Param('itemId', new ParseUUIDPipe({ optional: true })) paramItemId?: string,
    @Query('itemId') queryItemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const resolvedItemId =
      paramItemId ||
      queryItemId ||
      (await this.resolveAttachmentItemId(
        attachmentId,
        userId,
        effectiveProjectId,
      ));

    return this.attachmentsService.setPrimaryAttachment(
      userId,
      resolvedItemId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Patch(['attachments/:attachmentId', 'attachments/:attachmentId/rename'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Rename attachment file' })
  async renameAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Body() dto: RenameAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    return this.attachmentsService.renameAttachment(
      userId,
      attachmentId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/batch-rename')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Batch rename attachments' })
  async batchRenameAttachments(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchRenameAttachmentsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    return this.attachmentsService.batchRenameAttachments(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('items/:itemId/attachments/snapshot')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and archive a web snapshot for an item URL',
  })
  async captureWebSnapshot(
    @CurrentUser('id') userId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: CaptureSnapshotDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    if (!this.webSnapshotService) {
      throw new NotFoundException(
        'Web snapshot capability is disabled or unconfigured',
      );
    }
    const projectId = paramProjectId || queryProjectId;
    const targetUrl =
      body?.url?.trim() ||
      (await this.attachmentsService.resolveItemUrl(itemId, userId, projectId));
    return this.webSnapshotService.captureAndAttach(targetUrl, itemId, userId, {
      title: body?.title,
      projectId,
    });
  }

  private async resolveAttachmentItemId(
    attachmentId: string,
    userId?: string,
    projectId?: string,
  ): Promise<string> {
    const att = await this.attachmentsService.assertAttachmentExists(
      attachmentId,
      userId,
      undefined,
      projectId,
    );
    return att?.itemId || '';
  }
}

const MAX_BENCHMARK_PDF_BYTES = 50 * 1024 * 1024; // 50 MB

@ApiTags('Library Extraction Telemetry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@Controller([
  'api/v1/library/extraction',
  'api/v1/projects/:projectId/library/extraction',
])
export class ExtractionTelemetryController {
  constructor(
    @Inject(EXTRACTION_FACADE)
    private readonly extractionFacade: IExtractionFacade,
    @Optional() private readonly attachmentsService?: AttachmentsService,
  ) {}

  /**
   * Returns operational telemetry and engine metrics for dashboards.
   */
  @Get('telemetry')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
  @ApiOperation({
    summary:
      'Get operational telemetry and in-process extraction engine metrics',
  })
  async getTelemetry(
    @CurrentUser('id') userId?: string,
    @Param('projectId') projectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const attachmentStatusCounts = this.attachmentsService
      ? await this.attachmentsService.getExtractionStatusBreakdown(
          userId || effectiveProjectId
            ? { userId, projectId: effectiveProjectId }
            : undefined,
        )
      : {};
    const totalAttachments = Object.values(attachmentStatusCounts).reduce(
      (sum, count) => sum + count,
      0,
    );

    return {
      status: 'UP',
      architecture: 'Zero-Docker In-Process Academic Extraction Engine',
      version: '1.0.0',
      flags: {
        enabled: true,
        zeroDocker: true,
        fallbackMode: 'in-process-heuristics',
        pipelineMode: 'deterministic-heuristic-pipeline',
      },
      metrics: {
        latencyTarget: '< 20ms',
        supportedFormats: ['PDF', 'XMP', 'BibTeX', 'RIS'],
        cascades: ['XMP', 'REGEX', 'LAYOUT'],
        attachments: {
          total: totalAttachments,
          byStatus: attachmentStatusCounts,
        },
      },
    };
  }

  /**
   * Benchmarks in-process academic extraction against a raw PDF stream or base64 payload.
   * Measures precise execution latency in milliseconds and evaluates the Quality Gate.
   */
  @Post('benchmark')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Benchmark in-process academic metadata extraction against PDF buffer',
  })
  @ApiBody({
    description: 'Multipart file upload or JSON payload containing base64Pdf',
    required: false,
  })
  async benchmarkExtraction(
    @Req() req: FastifyRequest,
    @Body() body?: BenchmarkPayloadDto,
  ) {
    let buffer: Buffer | undefined;
    let filename = body?.filename || 'benchmark.pdf';

    // 1. Try reading base64 from JSON payload
    if (body?.base64Pdf && typeof body.base64Pdf === 'string') {
      const cleanBase64 = body.base64Pdf.replace(
        /^data:application\/pdf;base64,/,
        '',
      );
      if (cleanBase64.length > Math.ceil((MAX_BENCHMARK_PDF_BYTES * 4) / 3)) {
        throw new PayloadTooLargeException(
          'Benchmark PDF payload exceeds the 50MB size limit',
        );
      }
      buffer = Buffer.from(cleanBase64, 'base64');
    }

    // 2. Try reading multipart stream if Fastify multipart is available
    interface FastifyMultipartRequest {
      parts: () => AsyncIterable<{
        type: string;
        filename?: string;
        toBuffer: () => Promise<Buffer>;
      }>;
    }
    const multipartReq = req as unknown as FastifyMultipartRequest;
    if (!buffer && typeof multipartReq.parts === 'function') {
      try {
        const parts = multipartReq.parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            buffer = await part.toBuffer();
            filename = part.filename || filename;
          }
        }
      } catch {
        // Non-multipart request falls through
      }
    }

    if (!buffer || buffer.length === 0) {
      throw new BadRequestException(
        'Please provide a PDF file via multipart upload or base64Pdf JSON field',
      );
    }

    if (buffer.length > MAX_BENCHMARK_PDF_BYTES) {
      throw new PayloadTooLargeException(
        'Benchmark PDF payload exceeds the 50MB size limit',
      );
    }

    const start = performance.now();
    const result = await this.extractionFacade.extractTrustedMetadata(buffer, filename);
    const latencyMs = performance.now() - start;

    return {
      success: true,
      benchmark: {
        executionLatencyMs: Math.round(latencyMs * 100) / 100,
        engineUsed: result.provenance.engineUsed,
        isSelfSufficient: result.isSelfSufficient,
        qualityScore: result.quality.totalScore,
        breakdown: result.quality,
        missingFields: result.missingFields || [],
      },
      extractedMetadata: result.metadata,
    };
  }
}
