import { Test, TestingModule } from '@nestjs/testing';
import { LatexService } from '@/modules/manuscript/latex/latex.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core/database/prisma.service';

describe('LatexService', () => {
  let service: LatexService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LatexService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('http://localhost:2918'),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            page: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<LatexService>(LatexService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return fallback compilation response when compiler offline', async () => {
    const result = await service.compile({
      project_id: 'p-1',
      source: '\\documentclass{article}\\begin{document}Hello\\end{document}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fallback).toBe(true);
      expect(result.error).toBe('LaTeX compilation fallback');
    }
  });
});
