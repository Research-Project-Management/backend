import { Test, TestingModule } from '@nestjs/testing';
import { SynctexService } from '@/modules/document/synctex/synctex.service';
import { ConfigService } from '@nestjs/config';

describe('Document SynctexService (Code <-> PDF 2-Way Navigation)', () => {
  let service: SynctexService;

  beforeEach(async () => {
    const mockConfig = {
      get: jest.fn().mockReturnValue('http://localhost:2918'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SynctexService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<SynctexService>(SynctexService);
  });

  describe('forwardSync', () => {
    it('should return calculated fallback coordinates if compiler service is offline', async () => {
      // Fetch will fail or abort because localhost:2918 mock is not running in unit test
      const res = await service.forwardSync({
        file: 'main.tex',
        line: 25,
        column: 4,
      });

      expect(res.success).toBe(true);
      expect(res.fallback).toBe(true);
      expect(res.result).toBeDefined();
      expect(res.result?.page).toBe(1);
      expect(res.result?.y).toBeGreaterThan(100);
    });

    it('should calculate page > 1 for lines past line 50', async () => {
      const res = await service.forwardSync({
        file: 'main.tex',
        line: 120,
      });

      expect(res.success).toBe(true);
      expect(res.result?.page).toBe(3); // 120 / 50 = ceil(2.4) = 3
    });
  });

  describe('reverseSync', () => {
    it('should return calculated fallback source position if compiler service is offline', async () => {
      const res = await service.reverseSync({
        page: 2,
        x: 100,
        y: 250,
      });

      expect(res.success).toBe(true);
      expect(res.fallback).toBe(true);
      expect(res.result).toBeDefined();
      expect(res.result?.file).toBe('main.tex');
      expect(res.result?.line).toBeGreaterThan(50); // page 2
    });
  });
});
