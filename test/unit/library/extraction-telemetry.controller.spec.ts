import { BadRequestException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ExtractionTelemetryController } from '@/modules/library/extraction/controllers/extraction-telemetry.controller';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import { TrustedExtractionResult } from '@/modules/library/extraction/types/trusted-extraction.types';

describe('ExtractionTelemetryController', () => {
  let controller: ExtractionTelemetryController;
  let trustedExtractor: jest.Mocked<TrustedExtractionService>;

  beforeEach(() => {
    trustedExtractor = {
      extract: jest.fn(),
    } as unknown as jest.Mocked<TrustedExtractionService>;

    controller = new ExtractionTelemetryController(trustedExtractor);
  });

  describe('GET /telemetry', () => {
    it('returns formatted telemetry metrics for in-process engine', () => {
      const response = controller.getTelemetry();

      expect(response.status).toBe('UP');
      expect(response.architecture).toBe(
        'Zero-Docker In-Process Academic Extraction Engine',
      );
      expect(response.flags.enabled).toBe(true);
      expect(response.flags.zeroDocker).toBe(true);
      expect(response.metrics.supportedFormats).toContain('PDF');
    });
  });

  describe('POST /benchmark', () => {
    const mockExtractionResult: TrustedExtractionResult = {
      metadata: {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang'],
        doi: '10.1109/CVPR.2016.90',
        year: 2016,
        publicationName: 'CVPR',
      },
      quality: {
        totalScore: 0.95,
        titleScore: 0.3,
        authorScore: 0.25,
        identifierScore: 0.2,
        yearScore: 0.15,
        venueScore: 0.05,
      },
      isSelfSufficient: true,
      missingFields: [],
      provenance: {
        extractedAt: '2026-01-01T00:00:00.000Z',
        engineUsed: 'XMP_BINARY',
        executionTimeMs: 42,
        qualityBreakdown: {
          totalScore: 0.95,
          titleScore: 0.3,
          authorScore: 0.25,
          identifierScore: 0.2,
          yearScore: 0.15,
          venueScore: 0.05,
        },
      },
    };

    it('throws BadRequestException if neither base64 nor multipart buffer is provided', async () => {
      const mockReq = {} as FastifyRequest;

      await expect(controller.benchmarkExtraction(mockReq, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('extracts metadata from JSON base64Pdf payload and formats benchmark metrics', async () => {
      trustedExtractor.extract.mockResolvedValueOnce(mockExtractionResult);

      const fakePdfBytes = Buffer.from('%PDF-1.4 test content');
      const base64Pdf = `data:application/pdf;base64,${fakePdfBytes.toString('base64')}`;

      const mockReq = {} as FastifyRequest;
      const res = await controller.benchmarkExtraction(mockReq, {
        base64Pdf,
        filename: 'resnet.pdf',
      });

      expect(trustedExtractor.extract).toHaveBeenCalledWith(
        expect.any(Buffer),
        'resnet.pdf',
      );
      expect(res.success).toBe(true);
      expect(res.benchmark.isSelfSufficient).toBe(true);
      expect(res.benchmark.qualityScore).toBe(0.95);
      expect(res.benchmark.engineUsed).toBe('XMP_BINARY');
      expect(res.benchmark.executionLatencyMs).toBeGreaterThanOrEqual(0);
      expect(res.benchmark.estimatedGrobidLatencyMs).toBe(1200);
      expect(res.benchmark.estimatedSpeedupRatio).toMatch(/^\d+x$/);
      expect(res.extractedMetadata.title).toBe(
        'Deep Residual Learning for Image Recognition',
      );
    });

    it('handles raw base64 string without data: prefix', async () => {
      trustedExtractor.extract.mockResolvedValueOnce(mockExtractionResult);

      const fakePdfBytes = Buffer.from('%PDF-1.5 test raw');
      const rawBase64 = fakePdfBytes.toString('base64');

      const mockReq = {} as FastifyRequest;
      const res = await controller.benchmarkExtraction(mockReq, {
        base64Pdf: rawBase64,
      });

      expect(trustedExtractor.extract).toHaveBeenCalledWith(
        expect.any(Buffer),
        'benchmark.pdf',
      );
      expect(res.success).toBe(true);
      expect(res.extractedMetadata.doi).toBe('10.1109/CVPR.2016.90');
    });

    it('handles multipart/form-data upload when req.parts() is available', async () => {
      trustedExtractor.extract.mockResolvedValueOnce(mockExtractionResult);

      const fakePdfBytes = Buffer.from('%PDF-1.7 multipart stream');
      const mockParts = async function* () {
        yield {
          type: 'file',
          filename: 'multipart-paper.pdf',
          toBuffer: async () => fakePdfBytes,
        };
      };

      const mockReq = {
        parts: mockParts,
      } as unknown as FastifyRequest;

      const res = await controller.benchmarkExtraction(mockReq, {});

      expect(trustedExtractor.extract).toHaveBeenCalledWith(
        fakePdfBytes,
        'multipart-paper.pdf',
      );
      expect(res.success).toBe(true);
      expect(res.benchmark.qualityScore).toBe(0.95);
    });
  });
});
