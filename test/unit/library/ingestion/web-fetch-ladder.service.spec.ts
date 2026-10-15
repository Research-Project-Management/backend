import { WebFetchLadderService } from '@/modules/library/ingestion/services/web-fetch-ladder.service';
import { IngestionVerifierService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { SsrfGuardService } from '@/modules/library/shared-kernel/core/services/ssrf-guard.service';

describe('WebFetchLadderService', () => {
  let service: WebFetchLadderService;
  let mockVerifier: IngestionVerifierService;
  let mockSsrfGuard: jest.Mocked<SsrfGuardService>;

  beforeEach(() => {
    mockVerifier = new IngestionVerifierService();
    mockSsrfGuard = {
      assertSafeUrl: jest
        .fn()
        .mockResolvedValue(new URL('https://example.com')),
    } as any;

    service = new WebFetchLadderService(mockSsrfGuard, mockVerifier);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Ladder 0: Identifier Derivation', () => {
    it('derives DOI from publisher URL structure offline', async () => {
      // Mock fetch rejection so we only test derivation when offline
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const res = await service.fetch(
        'https://link.springer.com/article/10.1007/s11263-015-0816-y',
      );

      expect(res.derivedIdentifier?.doi).toBe('10.1007/s11263-015-0816-y');
      expect(res.ladderStepReached).toBe(4); // Ladder reached step 4 because network was offline
      expect(res.isBlocked).toBe(true);
      expect(res.promptUploadPdf).toBe(true);
    });

    it('derives arXiv ID from arXiv URL offline', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const res = await service.fetch('https://arxiv.org/abs/1706.03762v7');

      expect(res.derivedIdentifier?.arxivId).toBe('1706.03762v7');
    });

    it('derives PMID from PubMed URL offline', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const res = await service.fetch(
        'https://pubmed.ncbi.nlm.nih.gov/29322995/',
      );

      expect(res.derivedIdentifier?.pmid).toBe('29322995');
    });
    it('derives PMCID from PMC URL offline', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const res = await service.fetch(
        'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7144807/',
      );

      expect(res.derivedIdentifier?.pmcid).toBe('PMC7144807');
    });
  });

  describe('Ladder 1: Plain HTTP Fetch', () => {
    it('returns clean HTML with ladderStepReached = 1 on 200 OK', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Clean Academic Article</title></head>
        <body><p>Content</p></body>
        </html>
      `;

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: jest.fn().mockResolvedValue(mockHtml),
      } as any);

      const res = await service.fetch('https://clean.journal.org/article/123');

      expect(res.isBlocked).toBe(false);
      expect(res.status).toBe(200);
      expect(res.ladderStepReached).toBe(1);
      expect(res.bodyText).toBe(mockHtml);
    });

    it('detects PDF stream with magic bytes and returns bodyBuffer', async () => {
      const pdfHeader = Buffer.from('%PDF-1.4\n%test');
      const arrayBuf = new Uint8Array(pdfHeader).buffer;

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: jest.fn().mockResolvedValue(arrayBuf),
      } as any);

      const res = await service.fetch('https://arxiv.org/pdf/1706.03762.pdf');

      expect(res.isBlocked).toBe(false);
      expect(res.isPdf).toBe(true);
      expect(res.ladderStepReached).toBe(1);
      expect(res.bodyBuffer).toBeDefined();
    });

    it('automatically downloads direct PDF when URL is an arXiv abstract page', async () => {
      const pdfHeader = Buffer.from('%PDF-1.5\n%test');
      const arrayBuf = new Uint8Array(pdfHeader).buffer;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: jest.fn().mockResolvedValue(arrayBuf),
      } as any);

      const res = await service.fetch('https://arxiv.org/abs/1706.03762');

      expect(res.isPdf).toBe(true);
      expect(res.ladderStepReached).toBe(1);
      expect(res.bodyBuffer).toBeDefined();
      expect(res.derivedIdentifier?.arxivId).toBe('1706.03762');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://arxiv.org/pdf/1706.03762.pdf',
        expect.anything(),
      );
    });

    it('derives printable PDF URL for PLOS ONE articles', async () => {
      const pdfHeader = Buffer.from('%PDF-1.6\n%test');
      const arrayBuf = new Uint8Array(pdfHeader).buffer;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: jest.fn().mockResolvedValue(arrayBuf),
      } as any);

      const res = await service.fetch(
        'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0248823',
      );

      expect(res.isPdf).toBe(true);
      expect(res.ladderStepReached).toBe(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0248823&type=printable',
        expect.anything(),
      );
    });
  });

  describe('Ladder 2: Open Mirror Resolver (EuropePMC, CrossRef, OpenAlex)', () => {
    it('resolves metadata via EuropePMC when Ladder 1 receives 403 WAF block', async () => {
      const doi = '10.1101/2020.03.22.002386'; // BioRxiv DOI
      const url = `https://www.biorxiv.org/content/${doi}v1`;

      // Step 1: Plain fetch returns 403 Forbidden (Cloudflare WAF)
      const mockWafResponse = {
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: jest
          .fn()
          .mockResolvedValue('<html><title>Just a moment...</title></html>'),
      };

      // Step 2: EuropePMC mirror API returns structured JSON
      const mockEuropePmcJson = {
        hitCount: 1,
        resultList: {
          result: [
            {
              id: 'PPR141444',
              title: 'Structure of the SARS-CoV-2 spike glycoprotein',
              authorString: 'Walls AC, Park YJ, Tortorici MA',
              pubYear: '2020',
              doi: '10.1101/2020.03.22.002386',
              journalTitle: 'bioRxiv',
              abstractText:
                '<p>The emergence of SARS-CoV-2 has caused a global pandemic.</p>',
              isOpenAccess: 'Y',
              fullTextUrlList: {
                fullTextUrl: [
                  {
                    url: 'https://europepmc.org/articles/PMC123.pdf',
                    documentStyle: 'pdf',
                  },
                ],
              },
            },
          ],
        },
      };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockWafResponse as any) // Step 1 fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue(mockEuropePmcJson),
        } as any); // Step 2 EuropePMC search

      const res = await service.fetch(url);

      expect(res.isBlocked).toBe(false);
      expect(res.ladderStepReached).toBe(2);
      expect(res.mirrorMetadata).toBeDefined();
      expect(res.mirrorMetadata?.title).toBe(
        'Structure of the SARS-CoV-2 spike glycoprotein',
      );
      expect(res.mirrorMetadata?.authors).toEqual([
        'Walls AC',
        'Park YJ',
        'Tortorici MA',
      ]);
      expect(res.mirrorMetadata?.year).toBe(2020);
      expect(res.mirrorMetadata?.sourceMirror).toBe('EuropePMC');
      expect(res.mirrorMetadata?.abstract).toContain('emergence of SARS-CoV-2');
    });

    it('resolves metadata via OpenAlex mirror when EuropePMC and CrossRef do not find it', async () => {
      const url = 'https://ieeexplore.ieee.org/document/9876543';

      const mockWafResponse = {
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: jest
          .fn()
          .mockResolvedValue('<html><title>Access Denied</title></html>'),
      };

      const mockOpenAlexJson = {
        results: [
          {
            id: 'https://openalex.org/W9876543',
            doi: 'https://doi.org/10.1109/TPAMI.2022.9876543',
            title: 'Deep Learning in Radar Signal Processing',
            publication_year: 2022,
            authorships: [
              { author: { display_name: 'John Doe' } },
              { author: { display_name: 'Jane Smith' } },
            ],
            primary_location: {
              source: {
                display_name:
                  'IEEE Transactions on Pattern Analysis and Machine Intelligence',
              },
              pdf_url: 'https://openaccess.ieee.org/document/9876543.pdf',
            },
            open_access: {
              is_oa: true,
              oa_url: 'https://openaccess.ieee.org/document/9876543.pdf',
            },
            abstract_inverted_index: {
              Radar: [0],
              signal: [1],
              processing: [2],
              using: [3],
              deep: [4],
              neural: [5],
              networks: [6],
            },
          },
        ],
      };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockWafResponse as any) // Step 1: WAF block
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue(mockOpenAlexJson),
        } as any); // Step 2: OpenAlex URL lookup

      const res = await service.fetch(url);

      expect(res.isBlocked).toBe(false);
      expect(res.ladderStepReached).toBe(2);
      expect(res.mirrorMetadata?.sourceMirror).toBe('OpenAlex');
      expect(res.mirrorMetadata?.title).toBe(
        'Deep Learning in Radar Signal Processing',
      );
      expect(res.mirrorMetadata?.authors).toEqual(['John Doe', 'Jane Smith']);
      expect(res.mirrorMetadata?.year).toBe(2022);
      expect(res.mirrorMetadata?.journal).toBe(
        'IEEE Transactions on Pattern Analysis and Machine Intelligence',
      );
      expect(res.mirrorMetadata?.abstract).toBe(
        'Radar signal processing using deep neural networks',
      );
    });
  });

  describe('Ladder 3: Stealth Headless Fetcher Fallback', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('fetches via FlareSolverr when FLARESOLVERR_URL is configured', async () => {
      process.env.FLARESOLVERR_URL = 'http://localhost:8191/v1';

      const mockWafResponse = {
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: jest
          .fn()
          .mockResolvedValue(
            '<html><title>Cloudflare Challenge</title></html>',
          ),
      };

      const mockFlareSolverrResponse = {
        status: 'ok',
        solution: {
          status: 200,
          response:
            '<html><head><title>Bypassed Cloudflare Article</title></head><body>Content</body></html>',
        },
      };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockWafResponse as any) // Step 1: plain fetch 403
        .mockResolvedValueOnce({ ok: false, status: 404 } as any) // Step 2: Open mirror fails
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue(mockFlareSolverrResponse),
        } as any); // Step 3: FlareSolverr bypass

      const res = await service.fetch(
        'https://heavy-waf-site.org/article/special',
      );

      expect(res.isBlocked).toBe(false);
      expect(res.ladderStepReached).toBe(3);
      expect(res.bodyText).toContain('Bypassed Cloudflare Article');
    });
  });

  describe('Ladder 4: Fallback BLOCKED State', () => {
    it('gracefully returns BLOCKED when WAF blocks and no mirror matches', async () => {
      // Step 1: Plain fetch returns Bot Challenge
      const mockBotChallenge = {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: jest
          .fn()
          .mockResolvedValue(
            '<html><title>Attention Required | Cloudflare</title></html>',
          ),
      };

      // Step 2: EuropePMC mirror returns empty results
      const mockEmptyEuropePmc = {
        hitCount: 0,
        resultList: { result: [] },
      };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockBotChallenge as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue(mockEmptyEuropePmc),
        } as any);

      const res = await service.fetch(
        'https://protected.biorxiv.org/content/10.1101/999999v1',
      );

      expect(res.isBlocked).toBe(true);
      expect(res.ladderStepReached).toBe(4);
      expect(res.promptUploadPdf).toBe(true);
      expect(res.wafKind).toBeDefined();
    });
  });
});
