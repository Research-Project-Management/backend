import { Test, TestingModule } from '@nestjs/testing';
import { CompilerService } from '@/modules/document/compiler/compiler.service';
import { PageService } from '@/modules/document/page/page.service';
import { ConfigService } from '@nestjs/config';

describe('Document CompilerService - SyncTeX (Code <-> PDF 2-Way Navigation)', () => {
  let service: CompilerService;

  beforeEach(async () => {
    const mockConfig = {
      get: jest.fn().mockReturnValue('http://localhost:2918'),
    };
    const mockPageService = {
      findPageById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompilerService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: PageService, useValue: mockPageService },
      ],
    }).compile();

    service = module.get<CompilerService>(CompilerService);
  });

  describe('forwardSync', () => {
    it('should return error if compiler service is offline or synctex is not available (Overleaf deterministic alignment)', async () => {
      // Fetch will fail or abort because localhost:2918 mock is not running in unit test
      const res = await service.forwardSync({
        file: 'main.tex',
        line: 25,
        column: 4,
      });

      expect(res.success).toBe(false);
      expect(res.fallback).toBe(false);
      expect(res.error).toBe(
        'SyncTeX data not available. Please compile document first.',
      );
    });

    it('should parse ground truth coordinates when compiler service returns synctex', async () => {
      const mockResult = {
        page: 2,
        x: 150,
        y: 300,
        width: 400,
        height: 12,
        precision: 'ground_truth',
      };

      jest.spyOn<any, any>(service, 'postJson').mockResolvedValueOnce({
        success: true,
        result: mockResult,
      });

      const res = await service.forwardSync({
        file: 'main.tex',
        line: 45,
        column: 2,
      });

      expect(res.success).toBe(true);
      expect(res.result).toEqual(mockResult);
    });

    it('should reject invalid line and column numbers', async () => {
      await expect(
        service.forwardSync({
          file: 'main.tex',
          line: 0,
        }),
      ).rejects.toThrow();

      await expect(
        service.forwardSync({
          file: 'main.tex',
          line: 10,
          column: -5,
        }),
      ).rejects.toThrow();
    });
  });

  describe('reverseSync', () => {
    it('should return error if compiler service is offline or synctex is not available', async () => {
      const res = await service.reverseSync({
        page: 2,
        x: 100,
        y: 250,
      });

      expect(res.success).toBe(false);
      expect(res.fallback).toBe(false);
      expect(res.error).toBe(
        'SyncTeX data not available. Please compile document first.',
      );
    });

    it('should parse source line when compiler service returns reverse synctex', async () => {
      const mockResult = {
        file: 'chapters/intro.tex',
        line: 88,
        column: 5,
        precision: 'ground_truth',
      };

      jest.spyOn<any, any>(service, 'postJson').mockResolvedValueOnce({
        success: true,
        result: mockResult,
      });

      const res = await service.reverseSync({
        page: 2,
        x: 120,
        y: 400,
      });

      expect(res.success).toBe(true);
      expect(res.result).toEqual(mockResult);
    });

    it('should reject invalid page and negative coordinates', async () => {
      await expect(
        service.reverseSync({
          page: 0,
          x: 100,
          y: 250,
        }),
      ).rejects.toThrow();

      await expect(
        service.reverseSync({
          page: 1,
          x: -10,
          y: 250,
        }),
      ).rejects.toThrow();
    });
  });
});
