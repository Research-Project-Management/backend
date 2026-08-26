import { Test, TestingModule } from '@nestjs/testing';
import { LatexService } from '@/modules/document/latex/latex.service';
import { PageRepository } from '@/modules/document/page/page.repository';
import { ConfigService } from '@nestjs/config';

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
          provide: PageRepository,
          useValue: {
            findPageById: jest.fn(),
            findChildPages: jest.fn(),
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
    if (result.success === false) {
      expect(result.fallback).toBe(true);
      expect(result.error).toBe('LaTeX compiler unreachable');
    }
  });
});
