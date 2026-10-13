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
      assertSafeUrl: jest.fn().mockResolvedValue(new URL('https://example.com')),
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

      const res = await service.fetch('https://pubmed.ncbi.nlm.nih.gov/29322995/');

      expect(res.derivedIdentifier?.pmid).toBe('29322995');
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
  });

  describe('Ladder 2: Open Mirror Resolver (EuropePMC)', () => {
    it('resolves metadata via EuropePMC when Ladder 1 receives 403 WAF block', async () => {
      const doi = '10.1101/2020.03.22.002386'; // BioRxiv DOI
      const url = `https://www.biorxiv.org/content/${doi}v1`;

      // Step 1: Plain fetch returns 403 Forbidden (Cloudflare WAF)
      const mockWafResponse = {
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: jest.fn().mockResolvedValue('<html><title>Just a moment...</title></html>'),
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
              abstractText: '<p>The emergence of SARS-CoV-2 has caused a global pandemic.</p>',
              isOpenAccess: 'Y',
              fullTextUrlList: {
                fullTextUrl: [
                  { url: 'https://europepmc.org/articles/PMC123.pdf', documentStyle: 'pdf' },
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
  });

  describe('Ladder 4: Fallback BLOCKED State', () => {
    it('gracefully returns BLOCKED when WAF blocks and no mirror matches', async () => {
      // Step 1: Plain fetch returns Bot Challenge
      const mockBotChallenge = {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: jest.fn().mockResolvedValue('<html><title>Attention Required | Cloudflare</title></html>'),
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

      const res = await service.fetch('https://protected.biorxiv.org/content/10.1101/999999v1');

      expect(res.isBlocked).toBe(true);
      expect(res.ladderStepReached).toBe(4);
      expect(res.promptUploadPdf).toBe(true);
      expect(res.wafKind).toBeDefined();
    });
  });
});
