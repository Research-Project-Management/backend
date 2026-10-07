import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { TrustedExtractionService } from '../services/trusted-extraction.service';

export interface BenchmarkPayloadDto {
  base64Pdf?: string;
  filename?: string;
}

@ApiTags('Library Extraction Telemetry')
@Controller('api/v1/library/extraction')
export class ExtractionTelemetryController {
  constructor(private readonly trustedExtractor: TrustedExtractionService) {}

  /**
   * Returns operational telemetry and engine metrics for dashboards.
   */
  @Get('telemetry')
  @ApiOperation({
    summary:
      'Get operational telemetry and in-process extraction engine metrics',
  })
  getTelemetry() {
    return {
      status: 'UP',
      architecture: 'Zero-Docker In-Process Academic Extraction Engine',
      version: '1.0.0',
      flags: {
        enabled: true,
        zeroDocker: true,
        fallbackMode: 'in-process-heuristics',
        slmModel: 'Qwen2.5-0.5B-Instruct-ONNX',
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
      },
    };
  }

  /**
   * Benchmarks in-process academic extraction against a raw PDF stream or base64 payload.
   * Measures precise execution latency in milliseconds and evaluates the Quality Gate.
   */
  @Post('benchmark')
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
      buffer = Buffer.from(cleanBase64, 'base64');
    }

    // 2. Try reading multipart stream if Fastify multipart is available
    if (!buffer && typeof (req as any).parts === 'function') {
      try {
        const parts = (req as any).parts();
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

    const start = performance.now();
    const result = await this.trustedExtractor.extract(buffer, filename);
    const latencyMs = performance.now() - start;

    return {
      success: true,
      benchmark: {
        executionLatencyMs: Math.round(latencyMs * 100) / 100,
        baselineLegacyLatencyMs: 1200,
        estimatedGrobidLatencyMs: 1200,
        estimatedSpeedupRatio: `${Math.round(1200 / Math.max(latencyMs, 0.1))}x`,
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
