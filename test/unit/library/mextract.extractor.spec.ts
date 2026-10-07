import {
  MeXtractExtractor,
  MeXtractResult,
} from '@/modules/library/extraction/extractors/mextract.extractor';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import { extractText, getDocumentProxy } from 'unpdf';

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  getDocumentProxy: jest.fn(),
  getMeta: jest.fn(),
}));

describe('MeXtract Academic SLM Extractor (Tier 4)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FLUX_AI_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. Input Sanitization & Boundary Guards', () => {
    it('returns null when header text is empty or too short', async () => {
      expect(await MeXtractExtractor.extract('')).toBeNull();
      expect(await MeXtractExtractor.extract('   \n  \t  ')).toBeNull();
      expect(await MeXtractExtractor.extract('Short snippet')).toBeNull();
    });
  });

  describe('2. In-Process Rule-Guided Heuristic SLM (Fallback / 0ms Latency)', () => {
    it('extracts title, authors, abstract, and year from realistic unformatted preprint text', async () => {
      const preprintText = `
        arXiv:2401.99999v1 [cs.AI] 15 Jan 2024
        Autonomous Multi-Agent Planning Under Dynamic Operational Latencies
        Sarah Chen, Marcus Vance, Elena Rostova
        Computer Science Department, Stanford University
        {chen, vance, rostova}@stanford.edu

        Abstract—Coordinating autonomous agents in distributed environments requires robust planning
        against non-deterministic communication delays. In this work, we propose Latency-Aware
        Consensus (LAC), an algorithm provably converging under unbounded message jitter.
        Our extensive simulations demonstrate 4x lower deadlock frequency compared to Raft.

        1. Introduction
        Modern distributed systems face unpredictable latency spikes...
      `;

      const result = await MeXtractExtractor.extract(preprintText);

      expect(result).not.toBeNull();
      expect(result?.engine).toBe('MEXTRACT_HEURISTIC_SLM');
      expect(result?.metadata.title).toBe(
        'Autonomous Multi-Agent Planning Under Dynamic Operational Latencies',
      );
      expect(result?.metadata.authors).toEqual([
        'Sarah Chen',
        'Marcus Vance',
        'Elena Rostova',
      ]);
      expect(result?.metadata.abstract).toContain(
        'Coordinating autonomous agents in distributed environments',
      );
      expect(result?.metadata.abstract).not.toContain('1. Introduction');
      expect(result?.metadata.year).toBe(2024);
      expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('handles multi-line titles without including affiliations or emails', async () => {
      const headerText = `
        A Deep Learning Framework for Real-Time
        Neural Radiance Fields Optimization
        Alexander Wright, Sophia Loren 1, Daniel Craig 2
        1 Department of Computer Science, MIT
        2 Oxford Robotics Institute

        Abstract
        Neural radiance fields (NeRF) have revolutionized 3D scene reconstruction.
        However, synthesis latency remains prohibitive for VR applications.
        We introduce FlashNeRF, accelerating inference by 10x with novel caching.

        Keywords: NeRF, Real-time rendering, Ray tracing
      `;

      const result = await MeXtractExtractor.extract(headerText);

      expect(result).not.toBeNull();
      expect(result?.metadata.title).toBe(
        'A Deep Learning Framework for Real-Time Neural Radiance Fields Optimization',
      );
      expect(result?.metadata.authors).toEqual([
        'Alexander Wright',
        'Sophia Loren',
        'Daniel Craig',
      ]);
      expect(result?.metadata.abstract).toContain(
        'Neural radiance fields (NeRF) have revolutionized',
      );
      expect(result?.metadata.abstract).not.toContain('Keywords:');
    });
  });

  describe('3. Remote SLM Microservice Integration (FLUX_AI_URL)', () => {
    it('calls FLUX_AI_URL and normalizes structured JSON output when endpoint is healthy', async () => {
      process.env.FLUX_AI_URL = 'http://127.0.0.1:8000';

      const mockAiResponse = {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        year: 2016,
        journal:
          'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
        abstract:
          'Deeper neural networks are more difficult to train. We present a residual learning framework...',
        doi: '10.1109/CVPR.2016.90',
      };

      const globalFetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockAiResponse,
      } as any);

      const result = await MeXtractExtractor.extract(
        'Some paper text with residual learning mentions and CVPR headers...',
      );

      expect(globalFetchSpy).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.engine).toBe('MEXTRACT_LOCAL_SLM');
      expect(result?.confidence).toBe(0.95);
      expect(result?.metadata.title).toBe(
        'Deep Residual Learning for Image Recognition',
      );
      expect(result?.metadata.authors).toEqual([
        'Kaiming He',
        'Xiangyu Zhang',
        'Shaoqing Ren',
        'Jian Sun',
      ]);
      expect(result?.metadata.year).toBe(2016);
      expect(result?.metadata.journal).toBe(
        'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
      );
      expect(result?.metadata.doi).toBe('10.1109/CVPR.2016.90');

      globalFetchSpy.mockRestore();
    });

    it('gracefully falls back to in-process parser if FLUX_AI_URL fetch fails or times out', async () => {
      process.env.FLUX_AI_URL = 'http://127.0.0.1:8000';

      const globalFetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:8000'));

      const input = `
        Reinforcement Learning with Verifiable Safety Guarantees
        Elena Rostova, Victor Stone
        Abstract: We formalize safe reinforcement learning using control barrier functions.
      `;

      const result = await MeXtractExtractor.extract(input);

      expect(globalFetchSpy).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.engine).toBe('MEXTRACT_HEURISTIC_SLM');
      expect(result?.metadata.title).toBe(
        'Reinforcement Learning with Verifiable Safety Guarantees',
      );
      expect(result?.metadata.authors).toEqual([
        'Elena Rostova',
        'Victor Stone',
      ]);

      globalFetchSpy.mockRestore();
    });
  });

  describe('4. TrustedExtractionFacade Tier 4 Cascade Integration', () => {
    it('activates MeXtract SLM when XMP is absent and Regex cannot satisfy quality gate', async () => {
      const mockedExtractText = extractText as jest.Mock;
      const mockedGetDocumentProxy = getDocumentProxy as jest.Mock;

      mockedGetDocumentProxy.mockResolvedValue({
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          getViewport: () => ({ width: 612, height: 792 }),
          getTextContent: jest.fn().mockResolvedValue({ items: [] }),
        }),
      });

      // Sample paper without XMP packet and without standardized DOI stamps
      const rawPdfText = `
        Graph Neural Networks for Combinatorial Optimization
        David Silver, Demis Hassabis, Alex Graves
        DeepMind Technologies, London, UK

        Abstract
        Combinatorial optimization problems are ubiquitous in operations research.
        We demonstrate how graph neural networks can approximate NP-hard graph coloring.

        1. Introduction
        Graphs are natural representations for discrete problems...
      `;

      mockedExtractText.mockResolvedValue(rawPdfText);

      const facade = new TrustedExtractionService();
      const dummyBuffer = Buffer.from('%PDF-1.4 raw binary without XMP packet');

      const result = await facade.extract(dummyBuffer);

      expect(result).toBeDefined();
      expect(result.metadata.title).toBe(
        'Graph Neural Networks for Combinatorial Optimization',
      );
      expect(result.metadata.authors).toEqual([
        'David Silver',
        'Demis Hassabis',
        'Alex Graves',
      ]);
      expect(result.metadata.abstract).toContain(
        'Combinatorial optimization problems are ubiquitous',
      );
      expect(result.provenance.engineUsed).toBe('MEXTRACT_SLM');
      expect(result.provenance.rawMatches?.mextract).toBeDefined();
      expect(result.provenance.rawMatches?.mextract?.engine).toBe(
        'MEXTRACT_HEURISTIC_SLM',
      );
      expect(result.quality.titleScore).toBe(1.0);
      expect(result.quality.authorScore).toBe(1.0);
    });
  });
});
