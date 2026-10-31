import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  BadRequestException,
  PayloadTooLargeException,
  HttpCode,
  HttpStatus,
  Optional,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  ProjectRoles,
  ProjectRole,
} from '@/modules/project/access';
import { libraryConfig, normalizeProjectScopeId } from '@/modules/library/core';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import { OcrWorkerPoolService } from '@/modules/library/extraction/services/ocr-worker-pool.service';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';

const MAX_BENCHMARK_PDF_BYTES = 50 * 1024 * 1024; // 50 MB

export interface BenchmarkPayloadDto {
  base64Pdf?: string;
  filename?: string;
}

@ApiTags('Library Extraction Telemetry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@Controller([
  'api/v1/library/extraction',
  'api/v1/projects/:projectId/library/extraction',
])
export class ExtractionTelemetryController {
  constructor(
    private readonly trustedExtractor: TrustedExtractionService,
    @Optional() private readonly ocrWorkerPool?: OcrWorkerPoolService,
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
    const slmConfigured = Boolean(libraryConfig().mextract.apiUrl);
    const ocrPool = this.ocrWorkerPool?.getPoolStatus() ?? {
      initialized: false,
      destroyed: false,
      activeWorkers: 0,
      configuredConcurrency: libraryConfig().ocr.concurrency || 1,
      defaultLanguages: ['vie', 'eng'],
    };
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
      status: ocrPool.destroyed ? 'DEGRADED' : 'UP',
      architecture: 'Zero-Docker In-Process Academic Extraction Engine',
      version: '1.0.0',
      flags: {
        enabled: true,
        zeroDocker: true,
        fallbackMode: 'in-process-heuristics',
        pipelineMode: slmConfigured
          ? 'external-slm-with-heuristic-fallback'
          : 'deterministic-heuristic-pipeline',
      },
      metrics: {
        latencyTarget: '< 20ms',
        supportedFormats: ['PDF', 'XMP', 'BibTeX', 'RIS'],
        cascades: [
          'XMP_BINARY',
          'ACADEMIC_REGEX',
          'LAYOUT_HEURISTIC',
          'MEXTRACT_SLM',
        ],
        ocrWorkerPool: ocrPool,
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
    const result = await this.trustedExtractor.extract(buffer, filename);
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
