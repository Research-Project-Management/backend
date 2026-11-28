import { DblpProvider } from '@/modules/library/ingestion/providers/dblp.provider';
import { SemanticScholarProvider } from '@/modules/library/ingestion/providers/semantic-scholar.provider';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { OpenAlexProvider } from '@/modules/library/ingestion/providers/openalex.provider';
import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';
import { MetadataExecutorService } from '@/modules/library/ingestion/services/metadata-executor.service';
import { MetadataCache } from '@/modules/library/ingestion/services/metadata-cache.service';
import { MetadataService } from '@/modules/library/ingestion/services/metadata.service';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import {
  WebFetchLadderService,
  WebMirrorResolverService,
} from '@/modules/library/ingestion/services/web-fetch-ladder.service';
import { IngestionVerifierService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { FeedsService } from '@/modules/library/ingestion/services/feeds.service';
import { ResolvedMetadata } from '@/modules/library/ingestion/types/metadata.types';

describe('Library Ingestion Providers, Micro-Batching, Metadata Cache, Scraper & Web Ladder', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('DBLP & SemanticScholar Providers + Arxiv/OpenAlex Micro-Batching', () => {
    it('resolves DBLP conference/journal hits stripping author disambiguation numbers and degrades cleanly on network failure', async () => {
      const dblp = new DblpProvider();
      expect(dblp.supports('DOI')).toBe(true);
      expect(dblp.supports('PMID')).toBe(false);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    title: 'Attention is All you Need.',
                    authors: { author: ['Ashish Vaswani 0001', 'Noam Shazeer'] },
                    venue: 'NeurIPS',
                    year: '2017',
                    pages: '5998-6008',
                    type: 'Conference and Workshop Papers',
                    doi: '10.5555/3295222.3295349',
                  },
                },
              ],
            },
          },
        }),
      }) as unknown as typeof fetch;

      const hit = await dblp.resolve({
        query: '10.5555/3295222.3295349',
        queryType: 'DOI',
      });
      expect(hit?.metadata).toMatchObject({
        title: 'Attention is All you Need',
        itemType: 'conferencePaper',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
      });

      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET')) as unknown as typeof fetch;
      expect(
        await dblp.resolve({ query: 'Offline', queryType: 'TITLE' }),
      ).toBeNull();
    });

    it('resolves SemanticScholar DOI and title queries and handles 404 non-fatally', async () => {
      const s2 = new SemanticScholarProvider();
      expect(s2.supports('ARXIV')).toBe(true);
      expect(s2.supports('ISBN')).toBe(false);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          paperId: 'dc32a984',
          title: 'Highly accurate protein structure prediction with AlphaFold',
          year: 2021,
          venue: 'Nature',
          authors: [{ name: 'J. Jumper' }, { name: 'D. Hassabis' }],
          abstract: 'Proteins are essential to life.',
          openAccessPdf: { url: 'https://nature.com/alphafold.pdf' },
          externalIds: {
            DOI: '10.1038/s41586-021-03819-2',
            PubMed: '34265844',
          },
        }),
      }) as unknown as typeof fetch;

      const resolved = await s2.resolve({
        query: '10.1038/s41586-021-03819-2',
        queryType: 'DOI',
      });
      expect(resolved?.metadata).toMatchObject({
        year: 2021,
        journal: 'Nature',
        pmid: '34265844',
        url: 'https://nature.com/alphafold.pdf',
      });

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 }) as unknown as typeof fetch;
      expect(
        await s2.resolve({ query: '10.9999/404', queryType: 'DOI' }),
      ).toBeNull();
    });

    it('coalesces concurrent ArxivProvider (?id_list=) and OpenAlexProvider (?filter=doi:) calls via MetadataExecutorService', async () => {
      const arxiv = new ArxivProvider();
      const arxivSpy = jest
        .spyOn(
          arxiv as unknown as {
            fetchTextWithResilience: (url: string) => Promise<string>;
          },
          'fetchTextWithResilience',
        )
        .mockImplementation(async (url: string) => {
          const ids = decodeURIComponent(
            url.match(/id_list=([^&]+)/)?.[1] ?? '',
          ).split(',');
          const entries = ids
            .map(
              (id) =>
                `<entry><id>http://arxiv.org/abs/${id}v1</id><published>2023-03-01T00:00:00Z</published><title>Paper ${id}</title><summary>Abstract ${id}</summary><author><name>Alice</name></author></entry>`,
            )
            .join('');
          return `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
        });

      const executor = new MetadataExecutorService();
      const arxivRes = await Promise.all(
        ['2303.10001', '2303.10002', '2303.10003'].map((query) =>
          executor.execute(arxiv, { query, queryType: 'ARXIV' }),
        ),
      );
      expect(arxivSpy).toHaveBeenCalledTimes(1);
      expect(arxivRes.every((r) => r.status === 'found')).toBe(true);

      const openalex = new OpenAlexProvider();
      const oaSpy = jest
        .spyOn(
          openalex as unknown as {
            executeFetch: (url: string) => Promise<Response>;
          },
          'executeFetch',
        )
        .mockImplementation(async () => {
          const results = [0, 1, 2].map((i) => ({
            id: `https://openalex.org/W${i}`,
            doi: `https://doi.org/10.1038/oa-${i}`,
            title: `OA Work ${i}`,
            display_name: `OA Work ${i}`,
            publication_year: 2024,
            type: 'article',
            authorships: [{ author: { display_name: 'Jane Doe' } }],
          }));
          return {
            status: 200,
            ok: true,
            json: async () => ({ results }),
            headers: new Headers(),
          } as unknown as Response;
        });

      const oaRes = await Promise.all(
        ['10.1038/oa-0', '10.1038/oa-1', '10.1038/oa-2'].map((query) =>
          executor.execute(openalex, { query, queryType: 'DOI' }),
        ),
      );
      expect(oaSpy).toHaveBeenCalledTimes(1);
      expect(oaRes[2]?.result?.metadata.title).toBe('OA Work 2');
    });
  });

  describe('MetadataCache & DomainRateLimiterService', () => {
    it('supports L1 memory + L2 Redis + negative caching and isolates tenant data in MetadataService', async () => {
      const store = new Map<string, unknown>();
      const mockRedis = {
        isReady: () => true,
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
      };
      const cache = new MetadataCache(mockRedis as never);
      const sample: ResolvedMetadata = {
        query: '10.1038/s41586-020-2649-2',
        queryType: 'DOI',
        canonicalId: 'doi:10.1038/s41586-020-2649-2',
        metadata: { title: 'Cached Molecular Paper', year: 2020 },
        provenance: {},
        resolvedAt: '2025-01-01T00:00:00.000Z',
        policyVersion: 2,
      };

      const key = cache.buildKey('DOI', '10.1038/s41586-020-2649-2');
      await cache.set(key, sample, 'DOI');
      mockRedis.get.mockClear();

      const l1Hit = await cache.get(key);
      expect(l1Hit && l1Hit.metadata.title).toBe('Cached Molecular Paper');
      expect(mockRedis.get).not.toHaveBeenCalled();

      cache.clearMemoryCache();
      const l2Hit = await cache.get(key);
      expect(l2Hit && l2Hit.metadata.title).toBe('Cached Molecular Paper');
      expect(mockRedis.get).toHaveBeenCalledTimes(1);

      const negKey = cache.buildKey('DOI', '10.9999/missing');
      await cache.setNegative(negKey, 'DOI');
      cache.clearMemoryCache();
      expect(await cache.get(negKey)).toBe(false);

      const metadataService = new MetadataService(
        [],
        new MetadataCache(undefined),
        { execute: jest.fn() } as never,
      );
      expect(
        await metadataService.resolve({
          query: '10.1016/j.cell.2020.05.001',
          queryType: 'DOI',
        }),
      ).toBeNull();
    });

    it('normalizes domain keys, spaces same-domain requests without blocking distinct domains, and aborts on signal', async () => {
      const limiter = new DomainRateLimiterService();
      expect(limiter.normalizeKey('export.arxiv.org:443')).toBe(
        'export.arxiv.org',
      );
      expect(limiter.getConfig('arxiv').minIntervalMs).toBe(3000);

      limiter.setDomainConfig('domain-a', { minIntervalMs: 120 });
      limiter.setDomainConfig('domain-b', { minIntervalMs: 120 });
      const t0 = Date.now();
      await limiter.acquire('domain-a');
      await limiter.acquire('domain-b');
      expect(Date.now() - t0).toBeLessThan(60);

      const controller = new AbortController();
      const pending = limiter.acquire('domain-a', controller.signal);
      controller.abort(new Error('Aborted'));
      await expect(pending).rejects.toThrow('Aborted');
      limiter.reset();
    });
  });

  describe('UrlMetadataScraperService, WebFetchLadderService & FeedsService', () => {
    it('guards SSRF, scrapes Highwire HTML metadata, downloads PDFs, and falls back to humanized filename slugs', async () => {
      const ssrfGuard = {
        assertSafeUrl: jest
          .fn()
          .mockResolvedValue(new URL('https://example.com')),
      };
      const storagePort = {
        uploadFile: jest.fn().mockResolvedValue({
          fileId: 'file-storage-id',
          url: 'https://storage.flux.local/file.pdf',
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
          size: 128,
          path: '/storage/file.pdf',
        }),
      };
      const contentFacade = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          metadata: {},
          pages: [],
        }),
      };

      const scraper = new UrlMetadataScraperService(
        storagePort as never,
        contentFacade as never,
        ssrfGuard as never,
      );

      ssrfGuard.assertSafeUrl.mockRejectedValueOnce(new Error('Private IP'));
      const unsafe = await scraper.scrape('http://192.168.1.1/paper.pdf');
      expect(unsafe.fileId).toBeUndefined();

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => `<html><head>
          <meta name="citation_title" content="Attention Is All You Need">
          <meta name="citation_author" content="Vaswani, Ashish">
          <meta name="citation_publication_date" content="2017/12/04">
          <meta name="citation_doi" content="10.5555/3295222.3295349">
        </head></html>`,
      }) as unknown as typeof fetch;

      const htmlRes = await scraper.scrape(
        'https://proceedings.neurips.cc/paper/7181',
      );
      expect(htmlRes).toMatchObject({
        title: 'Attention Is All You Need',
        year: 2017,
        doi: '10.5555/3295222.3295349',
      });

      const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF');
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: async () =>
          pdfBytes.buffer.slice(
            pdfBytes.byteOffset,
            pdfBytes.byteOffset + pdfBytes.byteLength,
          ),
      }) as unknown as typeof fetch;

      const pdfRes = await scraper.scrape(
        'https://proceedings.neurips.cc/paper/7181-attention-is-all-you-need.pdf',
      );
      expect(pdfRes.fileId).toBe('file-storage-id');
      expect(pdfRes.title).toBe('Attention is all you need');
    });

    it('walks WebFetchLadder (offline ID derivation -> direct PDF rewrite -> EuropePMC/OpenAlex WAF mirror fallback -> BLOCKED)', async () => {
      const ssrfGuard = {
        assertSafeUrl: jest
          .fn()
          .mockResolvedValue(new URL('https://example.com')),
      };
      const ladder = new WebFetchLadderService(
        ssrfGuard as never,
        new IngestionVerifierService(),
        undefined,
        undefined,
        undefined,
        new WebMirrorResolverService(
          undefined,
          new CrossRefProvider(),
          new ArxivProvider(),
          new OpenAlexProvider(),
        ),
      );

      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('Offline')) as unknown as typeof fetch;
      const offline = await ladder.fetch(
        'https://link.springer.com/article/10.1007/s11263-015-0816-y',
      );
      expect(offline.derivedIdentifier?.doi).toBe('10.1007/s11263-015-0816-y');
      expect(offline.isBlocked).toBe(true);

      const pdfBuf = new Uint8Array(Buffer.from('%PDF-1.5\n%test')).buffer;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: async () => pdfBuf,
      }) as unknown as typeof fetch;
      const arxivPdf = await ladder.fetch('https://arxiv.org/abs/1706.03762');
      expect(arxivPdf.isPdf).toBe(true);
      expect(arxivPdf.ladderStepReached).toBe(1);

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html><title>Just a moment...</title></html>',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            hitCount: 1,
            resultList: {
              result: [
                {
                  title: 'Structure of the SARS-CoV-2 spike glycoprotein',
                  authorString: 'Walls AC, Park YJ',
                  pubYear: '2020',
                  doi: '10.1101/2020.03.22.002386',
                },
              ],
            },
          }),
        }) as unknown as typeof fetch;

      const mirrorRes = await ladder.fetch(
        'https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1',
      );
      expect(mirrorRes.isBlocked).toBe(false);
      expect(mirrorRes.ladderStepReached).toBe(2);
      expect(mirrorRes.mirrorMetadata?.sourceMirror).toBe('EuropePMC');
    });

    it('skips server-side feed fetch when client virtualizer provides customTitle and fetches otherwise', async () => {
      const fetchAcademicFeed = jest.fn().mockResolvedValue({
        feedTitle: 'Server Fetched Title',
        feedUrl: 'https://blog.example.com/feed.xml',
        entries: [],
      });
      const createFeed = jest
        .fn()
        .mockImplementation(async (d: Record<string, unknown>) => ({
          id: 'feed-1',
          ...d,
        }));
      const feedsService = new FeedsService(
        {
          findFeedByUrl: jest.fn().mockResolvedValue(null),
          createFeed,
          upsertSubscription: jest.fn().mockResolvedValue({ id: 'sub-1' }),
        } as never,
        { fetchAcademicFeed } as never,
      );

      await feedsService.subscribe(
        'user-1',
        'https://rss.arxiv.org/rss/cs.AI',
        'arXiv: cs.AI',
      );
      expect(fetchAcademicFeed).not.toHaveBeenCalled();

      await feedsService.subscribe(
        'user-1',
        'https://blog.example.com/feed.xml',
      );
      expect(fetchAcademicFeed).toHaveBeenCalledTimes(1);
    });
  });
});
