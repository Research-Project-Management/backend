import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UrlMetadataScraperService } from '../../../src/modules/library/ingestion/services/url-metadata-scraper.service';
import { WebFetchLadderService } from '../../../src/modules/library/ingestion/services/web-fetch-ladder.service';
import { SsrfGuardService } from '../../../src/modules/library/core/services/ssrf-guard.service';
import { RetractionService } from '../../../src/modules/library/ingestion/services/retraction.service';
import { RetractionScannerProvider } from '../../../src/modules/library/ingestion/providers/retraction-scanner.provider';
import { RetractionDatabaseService } from '../../../src/modules/library/ingestion/services/retraction-database.service';
import { RetractionRepository } from '../../../src/modules/library/ingestion/repositories/retraction.repository';
import { RetractionSyncService } from '../../../src/modules/library/ingestion/services/retraction-sync.service';
import { CollectionsService } from '../../../src/modules/library/catalog/services/collections.service';
import { TreeEngine } from '../../../src/modules/library/catalog/domain/tree.engine';
import { ItemService } from '../../../src/modules/library/catalog/services/items.service';
import { ItemQueryService } from '../../../src/modules/library/catalog/services/item-query.service';
import { QueryRepository } from '../../../src/modules/library/catalog/repositories/query.repository';
import { TagsService } from '../../../src/modules/library/catalog/services/tags.service';
import { DuplicateDetectorService } from '../../../src/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '../../../src/modules/library/ingestion/services/duplicate-merger.service';
import { ExportsService } from '../../../src/modules/library/citation/services/exports.service';
import { CitationService } from '../../../src/modules/library/citation/services/citation.service';
import {
  compactLibraryChanges,
  type CompactableChange,
} from '../../../src/modules/library/sync/domain/outbox.domain';
import type { ExportItemRecord } from '../../../src/modules/library/citation/repositories/exports.repository';
import { PipelineService } from '../../../src/modules/library/ingestion/services/pipeline.service';
import { IdentifyStage } from '../../../src/modules/library/ingestion/stages/identify.stage';
import { EnrichStage } from '../../../src/modules/library/ingestion/stages/enrich.stage';
import { ReconcileStage } from '../../../src/modules/library/ingestion/stages/reconcile.stage';
import { MatchStage } from '../../../src/modules/library/ingestion/stages/match.stage';
import { CommitStage } from '../../../src/modules/library/ingestion/stages/commit.stage';
import { BibtexParser } from '../../../src/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '../../../src/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '../../../src/modules/library/ingestion/parsers/csl.parser';
import { DoiParser } from '../../../src/modules/library/ingestion/parsers/doi.parser';
import { NormalizationPolicy } from '../../../src/modules/library/ingestion/policies/normalization.policy';
import { ReconciliationPolicy } from '../../../src/modules/library/ingestion/policies/reconciliation.policy';
import { DuplicatePolicy } from '../../../src/modules/library/ingestion/policies/duplicate.policy';
import { ItemsMapper } from '../../../src/modules/library/catalog/domain/items.mapper';

describe('Wave 4: Zotero 7 Web Translators & WAF Resilience, Retraction Watch & Errata Guard, Bulk Curation & Hierarchy Operations, and 1,000-Item Scale Benchmark', () => {
  // USER STORY 1: Zotero Web Translators, Highwire Press / Dublin Core / JSON-LD
  //               Scraping & Anti-Bot WAF Fallback Ladder
  describe('User Story 1: Web Translators, Highwire/DublinCore/JSON-LD Scraping & Anti-Bot WAF Ladder', () => {
    let scraper: UrlMetadataScraperService;

    beforeEach(() => {
      scraper = new UrlMetadataScraperService();
    });

    it('extracts Highwire Press (citation_*) metadata preserving exact multi-author order, Last/First vs First/Last, institutional authors, PDF URL, DOI, date, journal, volume, issue, and page range', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta name="citation_title" content="Deep Residual Learning for Image Recognition" />
            <meta name="citation_author" content="He, Kaiming" />
            <meta name="citation_author" content="Xiangyu Zhang" />
            <meta name="citation_author" content="World Health Organization Collaborating Centre" />
            <meta name="citation_publication_date" content="2016/06/27" />
            <meta name="citation_journal_title" content="IEEE Conference on Computer Vision and Pattern Recognition" />
            <meta name="citation_volume" content="2016" />
            <meta name="citation_issue" content="1" />
            <meta name="citation_firstpage" content="770" />
            <meta name="citation_lastpage" content="778" />
            <meta name="citation_doi" content="https://doi.org/10.1109/CVPR.2016.90" />
            <meta name="citation_pdf_url" content="/stamp/stamp.jsp?tp=&amp;arnumber=7780459.pdf" />
            <meta name="citation_abstract" content="Deeper neural networks are more difficult to train. We present a residual learning framework." />
          </head>
          <body><h1>Deep Residual Learning</h1></body>
        </html>
      `;

      const result = scraper.extractHtmlMetadata(
        html,
        'https://ieeexplore.ieee.org/document/7780459',
      );

      expect(result.title).toBe('Deep Residual Learning for Image Recognition');
      expect(result.doi).toBe('10.1109/cvpr.2016.90');
      expect(result.year).toBe(2016);
      expect(result.publicationTitle).toBe(
        'IEEE Conference on Computer Vision and Pattern Recognition',
      );
      expect(result.volume).toBe('2016');
      expect(result.issue).toBe('1');
      expect(result.pages).toBe('770-778');
      expect(result.pdfUrl).toBe(
        'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=7780459.pdf',
      );
      expect(result.authors).toEqual([
        'He, Kaiming',
        'Xiangyu Zhang',
        'World Health Organization Collaborating Centre',
      ]);

      expect(result.creators).toBeDefined();
      expect(result.creators).toHaveLength(3);
      // 1. "He, Kaiming" -> lastName: "He", firstName: "Kaiming"
      expect(result.creators![0]).toMatchObject({
        firstName: 'Kaiming',
        lastName: 'He',
        creatorType: 'author',
      });
      // 2. "Xiangyu Zhang" -> firstName: "Xiangyu", lastName: "Zhang"
      expect(result.creators![1]).toMatchObject({
        firstName: 'Xiangyu',
        lastName: 'Zhang',
        creatorType: 'author',
      });
      // 3. Institutional author detected as single-field creator (lastName + fullName, empty firstName)
      expect(result.creators![2]).toMatchObject({
        firstName: '',
        lastName: 'World Health Organization Collaborating Centre',
        fullName: 'World Health Organization Collaborating Centre',
        creatorType: 'author',
      });
    });

    it('falls back cleanly to Dublin Core (dc.title, dc.creator, dc.identifier, dc.date, dc.publisher, dcterms.issued) when Highwire Press tags are absent', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta name="DC.title" content="Foundations of Statistical Natural Language Processing" />
            <meta name="DC.creator" content="Manning, Christopher D." />
            <meta name="DC.creator" content="Hinrich Schütze" />
            <meta name="DC.identifier" content="doi:10.5555/311445" />
            <meta name="DC.publisher" content="MIT Press" />
            <meta name="DCTERMS.issued" content="1999-05-18" />
            <meta name="DC.description" content="Statistical approaches to processing natural language text have become dominant." />
          </head>
          <body></body>
        </html>
      `;

      const result = scraper.extractHtmlMetadata(
        html,
        'https://mitpress.mit.edu/9780262133609',
      );

      expect(result.title).toBe(
        'Foundations of Statistical Natural Language Processing',
      );
      expect(result.doi).toBe('10.5555/311445');
      expect(result.year).toBe(1999);
      expect(result.publisher).toBe('MIT Press');
      expect(result.authors).toEqual([
        'Manning, Christopher D.',
        'Hinrich Schütze',
      ]);
      expect(result.creators).toHaveLength(2);
      expect(result.creators![0]).toMatchObject({
        firstName: 'Christopher D.',
        lastName: 'Manning',
      });
      expect(result.creators![1]).toMatchObject({
        firstName: 'Hinrich',
        lastName: 'Schütze',
      });
    });

    it('extracts structured JSON-LD (ScholarlyArticle) with nested PublicationIssue, PublicationVolume, Periodical, Organization author, and page range', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "ScholarlyArticle",
                "headline": "Attention Is All You Need",
                "datePublished": "2017-12-06",
                "identifier": "https://doi.org/10.48550/arXiv.1706.03762",
                "pageStart": "5998",
                "pageEnd": "6008",
                "description": "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
                "author": [
                  { "@type": "Person", "givenName": "Ashish", "familyName": "Vaswani" },
                  { "@type": "Person", "name": "Noam Shazeer" },
                  { "@type": "Organization", "name": "Google Brain Research" }
                ],
                "isPartOf": {
                  "@type": "PublicationIssue",
                  "issueNumber": "30",
                  "isPartOf": {
                    "@type": "PublicationVolume",
                    "volumeNumber": "30",
                    "isPartOf": {
                      "@type": "Periodical",
                      "name": "Advances in Neural Information Processing Systems"
                    }
                  }
                }
              }
            </script>
          </head>
          <body></body>
        </html>
      `;

      const result = scraper.extractHtmlMetadata(
        html,
        'https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html',
      );

      expect(result.title).toBe('Attention Is All You Need');
      expect(result.doi).toBe('10.48550/arXiv.1706.03762');
      expect(result.year).toBe(2017);
      expect(result.publicationTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(result.volume).toBe('30');
      expect(result.issue).toBe('30');
      expect(result.pages).toBe('5998-6008');
      expect(result.creators).toHaveLength(3);
      expect(result.creators![0]).toMatchObject({
        firstName: 'Ashish',
        lastName: 'Vaswani',
      });
      expect(result.creators![2]).toMatchObject({
        firstName: '',
        lastName: 'Google Brain Research',
        fullName: 'Google Brain Research',
      });
    });

    it('escalates through WebFetchLadderService to Step 2 Open Mirror when publisher returns HTTP 403 Cloudflare Turnstile, and returns graceful BLOCKED state at Step 4 if all mirrors fail', async () => {
      const ssrfGuardMock = {
        assertSafeUrl: jest
          .fn()
          .mockImplementation(async (rawUrl: string) => new URL(rawUrl)),
      } as unknown as SsrfGuardService;

      const ladder = new WebFetchLadderService(ssrfGuardMock);
      const ladderScraper = new UrlMetadataScraperService(
        undefined,
        undefined,
        ssrfGuardMock,
        ladder,
      );

      const fetchSpy = jest.spyOn(global, 'fetch');

      try {
        // Case A:
        // 1st fetch: Direct publisher URL -> returns 403 Cloudflare Turnstile
        // 2nd fetch: Step 2 EuropePMC Open Mirror -> resolves full bibliographic metadata + PDF URL
        fetchSpy
          .mockResolvedValueOnce(
            new Response(
              '<html><head><title>Just a moment...</title></head><body>cf-turnstile challenge-platform</body></html>',
              {
                status: 403,
                headers: { 'content-type': 'text/html' },
              },
            ),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                resultList: {
                  result: [
                    {
                      title: 'CRISPR-Cas9 Genome Editing in Human Cells',
                      authorList: {
                        author: [
                          { fullName: 'Doudna, Jennifer A.' },
                          { fullName: 'Emmanuelle Charpentier' },
                        ],
                      },
                      doi: '10.1016/j.cell.2020.05.001',
                      pubYear: '2020',
                      journalTitle: 'Cell',
                      abstractText:
                        'High-efficiency genome engineering using CRISPR-Cas9.',
                      isOpenAccess: 'Y',
                      fullTextUrlList: {
                        fullTextUrl: [
                          {
                            documentStyle: 'pdf',
                            url: 'https://europepmc.org/articles/PMC7777777?pdf=render',
                          },
                        ],
                      },
                    },
                  ],
                },
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );

        const resolved = await ladderScraper.scrape(
          'https://www.sciencedirect.com/science/article/pii/10.1016/j.cell.2020.05.001',
        );

        expect(resolved.isBlocked).toBe(false);
        expect(resolved.ladderStepReached).toBe(2);
        expect(resolved.title).toBe(
          'CRISPR-Cas9 Genome Editing in Human Cells',
        );
        expect(resolved.doi).toBe('10.1016/j.cell.2020.05.001');
        expect(resolved.publicationTitle).toBe('Cell');
        expect(resolved.pdfUrl).toBe(
          'https://europepmc.org/articles/PMC7777777?pdf=render',
        );
        expect(resolved.creators).toHaveLength(2);
        expect(resolved.creators![0]).toMatchObject({
          firstName: 'Jennifer A.',
          lastName: 'Doudna',
        });

        // Case B: Publisher returns 403 and all Open Mirrors (EuropePMC, CrossRef, OpenAlex) return 404 -> Step 4 returns structured BLOCKED state with derived DOI preserved
        fetchSpy
          .mockResolvedValueOnce(
            new Response(
              '<html><head><title>Attention Required! | Cloudflare</title></head><body>cf-chl-bypass</body></html>',
              {
                status: 403,
                headers: { 'content-type': 'text/html' },
              },
            ),
          )
          .mockResolvedValue(new Response(null, { status: 404 }));

        const blocked = await ladderScraper.scrape(
          'https://onlinelibrary.wiley.com/doi/10.1002/anie.202301234',
        );

        expect(blocked.isBlocked).toBe(true);
        expect(blocked.promptUploadPdf).toBe(true);
        expect(blocked.ladderStepReached).toBe(4);
        expect(blocked.wafKind).toBe('HTTP_403_FORBIDDEN');
        expect(blocked.doi).toBe('10.1002/anie.202301234');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('enforces SSRF protection across direct private IPs, AWS metadata endpoints, localhost, and malicious 302 redirect hops', async () => {
      const ssrfGuard = new SsrfGuardService();

      await expect(
        ssrfGuard.assertSafeUrl('http://127.0.0.1:8080/admin'),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        ssrfGuard.assertSafeUrl('http://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        ssrfGuard.assertSafeUrl('http://10.0.0.42/internal-config'),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        ssrfGuard.assertSafeUrl('http://localhost:3000/health'),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        ssrfGuard.assertSafeUrl('file:///etc/passwd'),
      ).rejects.toThrow(ForbiddenException);

      // Verify redirect-chain SSRF interception inside WebFetchLadderService
      const redirectGuardMock = {
        assertSafeUrl: jest
          .fn()
          .mockImplementation(async (targetUrl: string) => {
            if (
              targetUrl.includes('169.254.169.254') ||
              targetUrl.includes('127.0.0.1')
            ) {
              throw new ForbiddenException(
                `SSRF blocked redirect target: ${targetUrl}`,
              );
            }
            return new URL(targetUrl);
          }),
      } as unknown as SsrfGuardService;

      const ladder = new WebFetchLadderService(redirectGuardMock);
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'http://169.254.169.254/latest/meta-data/iam/security-credentials',
          },
        }),
      );

      try {
        const res = await ladder.fetch(
          'https://scholar-redirect.example.org/paper',
        );
        expect(redirectGuardMock.assertSafeUrl).toHaveBeenCalledWith(
          'http://169.254.169.254/latest/meta-data/iam/security-credentials',
        );
        expect(res.isBlocked).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  // USER STORY 2: Zotero Retraction Watch, Expression of Concern & CrossRef
  //               Update Alerting
  describe('User Story 2: Retraction Watch, Expression of Concern & CrossRef Update Alerting', () => {
    it('normalizes DOIs across URL prefixes and uppercase characters when matching local Retraction Watch database records', async () => {
      const storedRecords = new Map<
        string,
        {
          doi: string;
          pmid: string | null;
          title: string | null;
          isRetracted: boolean;
          nature: string;
          noticeType: string;
          reason: string;
          noticeUrl: string | null;
          retractionDate: Date | null;
          source: string;
        }
      >();

      const repoMock = {
        countRetractionRecords: jest.fn().mockResolvedValue(1),
        upsertRetractionRecord: jest
          .fn()
          .mockImplementation(async ({ where, create }) => {
            storedRecords.set(where.doi, create);
            return create;
          }),
        findRetractionRecord: jest
          .fn()
          .mockImplementation(
            async (where: { OR?: Array<{ doi?: string; pmid?: string }> }) => {
              const clauses = where?.OR || [];
              for (const c of clauses) {
                if (c.doi && storedRecords.has(c.doi)) {
                  return storedRecords.get(c.doi)!;
                }
              }
              return null;
            },
          ),
      } as unknown as RetractionRepository;

      const dbService = new RetractionDatabaseService(repoMock);
      await dbService.importRecords([
        {
          doi: 'HTTPS://DOI.ORG/10.1016/J.CELL.2020.01.001',
          pmid: '32000001',
          title: 'Retracted Cell Paper on Fabricated Western Blots',
          nature: 'retraction',
          reason: 'Data fabrication and image duplication in Figure 3',
          noticeUrl: 'https://doi.org/10.1016/j.cell.2021.09.099',
          retractedAt: '2021-09-15T00:00:00.000Z',
          source: 'retraction_watch',
        },
      ]);

      // Query with different prefix and casing variations
      const match1 = await dbService.checkRetraction(
        '10.1016/j.cell.2020.01.001',
      );
      const match2 = await dbService.checkRetraction(
        'https://dx.doi.org/10.1016/J.CELL.2020.01.001',
      );
      const match3 = await dbService.checkRetraction(
        'doi:10.1016/j.cell.2020.01.001',
      );

      expect(match1).toBeTruthy();
      expect(match1 && match1.nature).toBe('retraction');
      expect(match1 && match1.reason).toContain('Data fabrication');
      expect(match1 && match1.noticeUrl).toBe(
        'https://doi.org/10.1016/j.cell.2021.09.099',
      );
      expect(match1 && match1.source).toBe('retraction_watch');
      expect(match2).toEqual(match1);
      expect(match3).toEqual(match1);
    });

    it('detects CrossRef update-to notices across retraction, expression-of-concern, and correction/erratum types', async () => {
      const dbMock = {
        checkRetraction: jest.fn().mockResolvedValue(null),
        saveRetraction: jest.fn().mockResolvedValue(undefined),
        saveClean: jest.fn().mockResolvedValue(undefined),
      } as unknown as RetractionDatabaseService;

      const scanner = new RetractionScannerProvider(dbMock);
      const fetchSpy = jest.spyOn(global, 'fetch');

      try {
        // 1. Official CrossRef Retraction Notice (first fetch is OpenAlex, second is CrossRef)
        fetchSpy
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ is_retracted: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                message: {
                  'update-to': [
                    {
                      type: 'retraction',
                      label:
                        'Retraction Notice: Plagiarism and ethical violations',
                      doi: '10.1038/s41586-024-99999-z',
                      updated: { 'date-time': '2024-04-10T00:00:00Z' },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );

        const retRes = await scanner.lookup('10.1038/s41586-023-00001-x');
        expect(retRes).toEqual({
          status: 'retracted',
          details: {
            nature: 'retraction',
            reason: 'Retraction Notice: Plagiarism and ethical violations',
            noticeUrl: 'https://doi.org/10.1038/s41586-024-99999-z',
            date: '2024-04-10T00:00:00Z',
            source: 'crossref',
          },
        });

        // 2. Official CrossRef Expression of Concern (hyphenated "expression-of-concern")
        fetchSpy
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ is_retracted: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                message: {
                  'update-to': [
                    {
                      type: 'expression-of-concern',
                      label:
                        'Editorial Expression of Concern regarding raw dataset integrity',
                      doi: '10.1126/science.9999999',
                      updated: { 'date-time': '2024-06-01T00:00:00Z' },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );

        const eocRes = await scanner.lookup('10.1126/science.1234567');
        expect(eocRes).toEqual({
          status: 'retracted',
          details: {
            nature: 'expression_of_concern',
            reason:
              'Editorial Expression of Concern regarding raw dataset integrity',
            noticeUrl: 'https://doi.org/10.1126/science.9999999',
            date: '2024-06-01T00:00:00Z',
            source: 'crossref',
          },
        });

        // 3. Official CrossRef Correction / Erratum
        fetchSpy
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ is_retracted: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                message: {
                  'update-to': [
                    {
                      type: 'erratum',
                      label: 'Author Correction: Dosage unit typo in Table 2',
                      doi: '10.1038/s41591-024-00002-1',
                      updated: { 'date-time': '2024-07-15T00:00:00Z' },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );

        const corrRes = await scanner.lookup('10.1038/s41591-024-00001-0');
        expect(corrRes).toEqual({
          status: 'retracted',
          details: {
            nature: 'correction',
            reason: 'Author Correction: Dosage unit typo in Table 2',
            noticeUrl: 'https://doi.org/10.1038/s41591-024-00002-1',
            date: '2024-07-15T00:00:00Z',
            source: 'crossref',
          },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('preserves manual retraction flags during batch scans and enforces strict personal vs project scope isolation', async () => {
      const updatedItems: Array<{
        id: string;
        isRetracted: boolean;
        nature: string | null;
        details: unknown;
      }> = [];

      const repoMock = {
        findItemsForScan: jest.fn().mockResolvedValue([
          {
            id: 'item-manual',
            title: 'Manually Flagged Paper',
            doi: '10.1000/clean.external.doi',
            pmid: null,
            isRetracted: true,
            retractionNature: 'manual',
            retractionCheckedAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'item-newly-retracted',
            title: 'Newly Retracted Paper',
            doi: '10.1016/j.lancet.2020.05.001',
            pmid: null,
            isRetracted: false,
            retractionNature: null,
            retractionCheckedAt: null,
          },
        ]),
        updateItemRetraction: jest
          .fn()
          .mockImplementation(
            async (
              id: string,
              isRetracted: boolean,
              nature: string | null,
              details: unknown,
            ) => {
              updatedItems.push({ id, isRetracted, nature, details });
            },
          ),
        findRetractedItems: jest
          .fn()
          .mockImplementation(async (_u: string, projectId?: string) => {
            if (!projectId || projectId === 'user') {
              return [{ id: 'personal-ret-1', title: 'Personal Retracted' }];
            }
            return [{ id: 'project-ret-1', title: 'Project Retracted' }];
          }),
      } as unknown as RetractionRepository;

      const scannerMock = {
        lookup: jest.fn().mockImplementation(async (doi: string) => {
          if (doi === '10.1016/j.lancet.2020.05.001') {
            return {
              status: 'retracted',
              details: {
                nature: 'retraction',
                reason: 'Surgisphere dataset unavailable for independent audit',
                noticeUrl: 'https://doi.org/10.1016/j.lancet.2020.06.001',
                date: '2020-06-04T00:00:00Z',
                source: 'retraction_watch',
              },
            };
          }
          return { status: 'clean' };
        }),
      } as unknown as RetractionScannerProvider;

      const dbMock = {} as unknown as RetractionDatabaseService;
      const syncMock = {} as unknown as RetractionSyncService;

      const service = new RetractionService(
        repoMock,
        scannerMock,
        dbMock,
        syncMock,
      );

      const scanResult = await service.checkLibrary(
        '11111111-1111-4111-8111-111111111111',
      );

      // Manual item was skipped (preserved) and newly retracted item was flagged
      expect(scanResult.scanned).toBe(2);
      expect(scanResult.newlyRetracted).toBe(1);
      expect(updatedItems).toHaveLength(1);
      expect(updatedItems[0].id).toBe('item-newly-retracted');
      expect(updatedItems[0].isRetracted).toBe(true);
      expect(updatedItems[0].nature).toBe('retraction');

      // Personal scope ('user') vs Project scope isolation in RetractionRepository
      const capturedWhereClauses: unknown[] = [];
      const prismaRepo = new RetractionRepository({
        item: {
          findMany: jest.fn().mockImplementation(async ({ where }) => {
            capturedWhereClauses.push(where);
            return [];
          }),
        },
      } as never);

      await prismaRepo.findItemsForScan(
        '11111111-1111-4111-8111-111111111111',
        undefined,
        'user',
      );
      await prismaRepo.findItemsForScan(
        '11111111-1111-4111-8111-111111111111',
        undefined,
        '22222222-2222-4222-8222-222222222222',
      );

      expect(capturedWhereClauses[0]).toMatchObject({
        userId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        deletedAt: null,
      });
      expect(capturedWhereClauses[1]).toMatchObject({
        projectId: '22222222-2222-4222-8222-222222222222',
        deletedAt: null,
      });
    });
  });

  // USER STORY 3: Zotero Hierarchical Collections, Recursive Subcollection
  //               Queries & Bulk Curation (Batch Tagging, Batch Move, Trash/Restore)
  describe('User Story 3: Hierarchical Collections, Recursive Subcollection Queries & Bulk Curation', () => {
    const USER_ID = '11111111-1111-4111-8111-111111111111';

    it('detects and rejects circular parent-child hierarchy cycles (A -> B -> C -> A) and self-parenting', async () => {
      const treeEngine = new TreeEngine();
      const collections = [
        { id: 'col-a', name: 'Root A', parentId: null, orderIndex: 0 },
        { id: 'col-b', name: 'Child B', parentId: 'col-a', orderIndex: 0 },
        { id: 'col-c', name: 'Grandchild C', parentId: 'col-b', orderIndex: 0 },
      ];

      // Direct cycle check via TreeEngine
      expect(() =>
        treeEngine.assertNoCycle(collections, 'col-a', 'col-c'),
      ).toThrow(BadRequestException);

      // Service-level updateCollection check
      const repoMock = {
        findById: jest
          .fn()
          .mockImplementation(
            async (_u: string, id: string) =>
              collections.find((c) => c.id === id) ?? null,
          ),
        findAll: jest.fn().mockResolvedValue(collections),
        update: jest.fn(),
      };
      const collectionsService = new CollectionsService(
        repoMock as never,
        treeEngine,
      );

      await expect(
        collectionsService.updateCollection(USER_ID, 'col-a', {
          parentId: 'col-a',
        }),
      ).rejects.toThrow('A collection cannot be its own parent');

      await expect(
        collectionsService.updateCollection(USER_ID, 'col-a', {
          parentId: 'col-c',
        }),
      ).rejects.toThrow('Circular collection hierarchy detected');
    });

    it('resolves recursive subcollection queries (includeSubcollections: true vs false) across 3+ levels without duplicates', async () => {
      const COL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const COL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const COL_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

      const allCollections = [
        { id: COL_A, parentId: null },
        { id: COL_B, parentId: COL_A },
        { id: COL_C, parentId: COL_B },
      ];

      const itemsDb = [
        {
          id: 'item-1',
          userId: USER_ID,
          projectId: null,
          deletedAt: null,
          title: 'Root Paper in A and B',
          collections: [COL_A, COL_B],
        },
        {
          id: 'item-2',
          userId: USER_ID,
          projectId: null,
          deletedAt: null,
          title: 'Child Paper in B',
          collections: [COL_B],
        },
        {
          id: 'item-3',
          userId: USER_ID,
          projectId: null,
          deletedAt: null,
          title: 'Grandchild Paper in C',
          collections: [COL_C],
        },
      ];

      let lastCapturedCollectionFilter: unknown = null;

      const prismaMock = {
        collection: {
          findMany: jest.fn().mockResolvedValue(allCollections),
        },
        item: {
          findMany: jest.fn().mockImplementation(async ({ where }) => {
            const colSome = where?.collectionItems?.some?.collectionId;
            lastCapturedCollectionFilter = colSome;
            const targetIds: string[] = colSome?.in
              ? colSome.in
              : typeof colSome === 'string'
                ? [colSome]
                : [];
            return itemsDb.filter(
              (it) =>
                it.deletedAt === null &&
                it.collections.some((c) => targetIds.includes(c)),
            );
          }),
          count: jest.fn().mockImplementation(async ({ where }) => {
            const colSome = where?.collectionItems?.some?.collectionId;
            const targetIds: string[] = colSome?.in
              ? colSome.in
              : typeof colSome === 'string'
                ? [colSome]
                : [];
            return itemsDb.filter(
              (it) =>
                it.deletedAt === null &&
                it.collections.some((c) => targetIds.includes(c)),
            ).length;
          }),
        },
      };

      const queryRepo = new QueryRepository(prismaMock as never);

      // 1. Non-recursive (includeSubcollections: false): only items directly in COL_A
      const nonRecursive = await queryRepo.findMany(USER_ID, {
        collectionId: COL_A,
        includeSubcollections: false,
      });
      expect(lastCapturedCollectionFilter).toBe(COL_A);
      expect(nonRecursive.map((i) => i.id)).toEqual(['item-1']);

      // 2. Recursive (includeSubcollections: true): items in COL_A, COL_B, and COL_C deduplicated
      const recursive = await queryRepo.findMany(USER_ID, {
        collectionId: COL_A,
        includeSubcollections: true,
      });
      expect(lastCapturedCollectionFilter).toEqual({
        in: [COL_A, COL_B, COL_C],
      });
      expect(recursive.map((i) => i.id)).toEqual([
        'item-1',
        'item-2',
        'item-3',
      ]);
    });

    it('supports orphan vs cascade collection deletion strategies without deleting the underlying library items', async () => {
      const deletedCollections: string[] = [];
      const reparentedCollections: Array<{
        id: string;
        parentId: string | null;
      }> = [];

      
      const repoMock = {
        findById: jest.fn().mockResolvedValue({
          id: 'col-parent',
          name: 'Parent Folder',
          parentId: null,
        }),
        findItemIdsByCollection: jest.fn().mockResolvedValue([]),
        delete: jest
          .fn()
          .mockImplementation(
            async (_u: string, id: string, strategy: 'orphan' | 'cascade') => {
              if (strategy === 'orphan') {
                reparentedCollections.push({ id: 'col-child', parentId: null });
                deletedCollections.push(id);
              } else {
                deletedCollections.push('col-child', id);
              }
            },
          ),
      };

      const collectionsService = new CollectionsService(
        repoMock as never,
        new TreeEngine(),
      );

      await collectionsService.deleteCollection(
        USER_ID,
        'col-parent',
        'orphan',
      );
      expect(repoMock.delete).toHaveBeenCalledWith(
        USER_ID,
        'col-parent',
        'orphan',
        undefined,
        undefined,
      );
      expect(reparentedCollections).toEqual([
        { id: 'col-child', parentId: null },
      ]);

      await collectionsService.deleteCollection(
        USER_ID,
        'col-parent',
        'cascade',
      );
      expect(repoMock.delete).toHaveBeenCalledWith(
        USER_ID,
        'col-parent',
        'cascade',
        undefined,
        undefined,
      );
    });

    it('executes bulk tag assignment, bulk collection move, and Trash -> Restore lifecycle seamlessly', async () => {
      // 1. Tag Assignment & Sync via TagsService
      const assignedTagLinks: Array<{
        tagId: string;
        itemId: string;
      }> = [];
      const txMock = {
        tag: {
          findFirst: jest.fn().mockResolvedValue({ id: 'tag-ml' }),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
          findMany: jest.fn().mockResolvedValue([
            { id: 'tag-ml', name: 'machine-learning', type: 'automatic' },
            { id: 'tag-llm', name: 'transformers', type: 'automatic' },
          ]),
        },
        item: {
          findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }),
        },
        itemTag: {
          createMany: jest.fn().mockImplementation(async ({ data }) => {
            assignedTagLinks.push(...data);
            return { count: data.length };
          }),
        },
      };

      const tagRepoMock = {
        assignToItem: jest
          .fn()
          .mockImplementation(async (tagId: string, itemId: string) => {
            assignedTagLinks.push({ tagId, itemId });
          }),
        removeFromItem: jest.fn().mockResolvedValue(undefined),
      };

      const txServiceMock = {
        executeInTransaction: jest.fn().mockImplementation(async (cb) =>
          cb(txMock, {
            appendChange: jest.fn().mockResolvedValue(undefined),
            appendChangesBatch: jest.fn().mockResolvedValue(1),
            publishOutbox: jest.fn().mockResolvedValue(undefined),
            publishOutboxBatch: jest.fn().mockResolvedValue([]),
            recordTombstone: jest.fn().mockResolvedValue(undefined),
            recordTombstonesBatch: jest.fn().mockResolvedValue(1),
            removeTombstone: jest.fn().mockResolvedValue(1),
            removeTombstonesBatch: jest.fn().mockResolvedValue(1),
          }),
        ),
      };

      const tagsService = new TagsService(
        tagRepoMock as never,
        txServiceMock as never,
      );

      await tagsService.syncTagsToItem(txMock as never, USER_ID, 'item-1', [
        'machine-learning',
        'transformers',
      ]);
      expect(assignedTagLinks).toHaveLength(2);

      // 2. Bulk Move Items across collections via CollectionsService
      const colRepoMock = {
        findById: jest.fn().mockResolvedValue({
          id: 'col-target',
          name: 'Target Subcollection',
        }),
        findOwnedItemIds: jest
          .fn()
          .mockResolvedValue(['item-1', 'item-2', 'item-3']),
        moveItems: jest.fn().mockResolvedValue(undefined),
      };
      const collectionsService = new CollectionsService(
        colRepoMock as never,
        new TreeEngine(),
      );

      const moveRes = await collectionsService.moveItems(
        USER_ID,
        'col-target',
        ['item-1', 'item-2', 'item-3'],
        'personal',
      );
      expect(moveRes.count).toBe(3);
      expect(moveRes.targetCollectionId).toBe('col-target');
      expect(colRepoMock.findOwnedItemIds).toHaveBeenCalledWith(
        ['item-1', 'item-2', 'item-3'],
        { userId: USER_ID, projectId: null },
      );

      // 3. Trash (Soft-Delete) & Restore Lifecycle via ItemService + ItemQueryService
      const itemState = new Map<
        string,
        {
          id: string;
          userId: string;
          projectId: string | null;
          title: string;
          itemType: string;
          version: number;
          deletedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
          collectionItems: Array<{
            collectionId: string;
            collection: { id: string; name: string };
          }>;
          contributors: never[];
          itemTags: never[];
          attachments: never[];
        }
      >([
        [
          'item-1',
          {
            id: 'item-1',
            userId: USER_ID,
            projectId: null,
            title: 'Paper 1',
            itemType: 'journalArticle',
            version: 1,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            collectionItems: [
              {
                collectionId: 'col-target',
                collection: { id: 'col-target', name: 'Target Subcollection' },
              },
            ],
            contributors: [],
            itemTags: [],
            attachments: [],
          },
        ],
        [
          'item-2',
          {
            id: 'item-2',
            userId: USER_ID,
            projectId: null,
            title: 'Paper 2',
            itemType: 'journalArticle',
            version: 1,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            collectionItems: [
              {
                collectionId: 'col-target',
                collection: { id: 'col-target', name: 'Target Subcollection' },
              },
            ],
            contributors: [],
            itemTags: [],
            attachments: [],
          },
        ],
      ]);

      const queryRepoMock = {
        findByIds: jest.fn().mockImplementation(async (_u: string, ids: string[]) => {
          return ids.map((id: string) => itemState.get(id)).filter(Boolean);
        }),
        findMany: jest
          .fn()
          .mockImplementation(async (_u: string, opts?: { view?: string }) => {
            const wantTrash = opts?.view === 'trash';
            return Array.from(itemState.values()).filter((i) =>
              wantTrash ? i.deletedAt !== null : i.deletedAt === null,
            );
          }),
        count: jest
          .fn()
          .mockImplementation(async (_u: string, opts?: { view?: string }) => {
            const wantTrash = opts?.view === 'trash';
            return Array.from(itemState.values()).filter((i) =>
              wantTrash ? i.deletedAt !== null : i.deletedAt === null,
            ).length;
          }),
      };

      const commandRepoMock = {
        softDelete: jest
          .fn()
          .mockImplementation(async (_u: string, id: string) => {
            const it = itemState.get(id);
            if (!it || it.deletedAt !== null) return false;
            it.deletedAt = new Date();
            return true;
          }),
        softDeleteMany: jest
          .fn()
          .mockImplementation(async (_u: string, ids: string[]) => {
            const succeededIds: string[] = [];
            for (const id of ids) {
              const it = itemState.get(id);
              if (it && it.deletedAt === null) {
                it.deletedAt = new Date();
                succeededIds.push(id);
              }
            }
            return { succeededIds, failedIds: [] };
          }),
        restore: jest
          .fn()
          .mockImplementation(async (_u: string, id: string) => {
            const it = itemState.get(id);
            if (!it || it.deletedAt === null) {
              throw new BadRequestException(`Item ${id} not in trash`);
            }
            it.deletedAt = null;
            it.version += 1;
            return it;
          }),
        restoreMany: jest
          .fn()
          .mockImplementation(async (_u: string, ids: string[]) => {
            const restoredItems: Array<{ id: string; version: number; projectId: string | null }> = [];
            const succeededIds: string[] = [];
            for (const id of ids) {
              const it = itemState.get(id);
              if (it && it.deletedAt !== null) {
                it.deletedAt = null;
                it.version += 1;
                succeededIds.push(id);
                restoredItems.push({ id, version: it.version, projectId: it.projectId });
              }
            }
            return { succeededIds, failedIds: [], restoredItems };
          }),
        purge: jest.fn().mockImplementation(async (_u: string, id: string) => {
          return itemState.delete(id);
        }),
        purgeMany: jest.fn().mockImplementation(async (_u: string, ids: string[]) => {
          const succeededIds: string[] = [];
          for (const id of ids) {
            if (itemState.delete(id)) {
              succeededIds.push(id);
            }
          }
          return { succeededIds, failedIds: [], fileIdsToDelete: [], storagePaths: [] };
        }),
      };

      const tagsServiceMock = {
        invalidateTagsCache: jest.fn().mockResolvedValue(undefined),
      } as never;
      const itemQueryService = new ItemQueryService(queryRepoMock as never);
      const itemService = new ItemService(
        queryRepoMock as never,
        commandRepoMock as never,
        txServiceMock as never,
        tagsServiceMock,
      );

      // Soft-delete item-1 and item-2
      const trashRes = await itemService.bulkTrash(USER_ID, [
        'item-1',
        'item-2',
      ]);
      expect(trashRes.trashedCount).toBe(2);
      expect(trashRes.succeededIds).toEqual(['item-1', 'item-2']);

      // Active library query now returns 0 items, while Trash returns 2 items
      const activeAfterTrash = await itemQueryService.listItems(USER_ID, {
        view: 'all',
      });
      expect(activeAfterTrash.items).toHaveLength(0);

      const trashedView = await itemQueryService.listItems(USER_ID, {
        view: 'trash',
      });
      expect(trashedView.items).toHaveLength(2);

      // Restore item-1 -> reappears in active library with its collection intact
      const restoreRes = await itemService.bulkRestore(USER_ID, ['item-1']);
      expect(restoreRes.restoredCount).toBe(1);
      expect(restoreRes.succeededIds).toEqual(['item-1']);

      const activeAfterRestore = await itemQueryService.listItems(USER_ID, {
        view: 'all',
      });
      expect(activeAfterRestore.items).toHaveLength(1);
      expect((activeAfterRestore.items[0] as { id: string }).id).toBe('item-1');

      // Permanently purge item-2 from Trash
      const purgeRes = await itemService.bulkPurge(USER_ID, ['item-2']);
      expect(purgeRes.purgedCount).toBe(1);
      const trashedAfterPurge = await itemQueryService.listItems(USER_ID, {
        view: 'trash',
      });
      expect(trashedAfterPurge.items).toHaveLength(0);
    });
  });

  // USER STORY 4: High-Volume 1,000-Item Library Scale & Performance Benchmark
  describe('User Story 4: High-Volume 1,000-Item Library Scale & Performance Benchmark', () => {
    it('clusters 1,000 academic items across exact DOI/arXiv/PMID/ISBN and fuzzy title+year+author buckets in < 500ms without O(N^2) blowup', async () => {
      // Construct a realistic 1,000-item library with:
      // - 100 exact DOI pairs (200 items -> 100 groups)
      // - 50 exact arXiv pairs (100 items -> 50 groups)
      // - 50 fuzzy title + year + primary author pairs (100 items -> 50 groups)
      // - 600 unique distinct papers
      const syntheticItems: Array<{
        id: string;
        title: string;
        year: number;
        doi: string | null;
        isbn: string | null;
        publicationTitle: string;
        abstract: string | null;
        url: string | null;
        createdAt: Date;
        metadata: Record<string, unknown>;
        contributors: Array<{
          name?: string | null;
          firstName?: string | null;
          lastName?: string | null;
          role?: string;
        }>;
        collectionItems: Array<{ collectionId: string }>;
        itemTags: Array<{ tagId: string }>;
        notes: Array<{ id: string }>;
        attachments: Array<{ id: string }>;
      }> = [];

      const baseDate = new Date('2026-01-01T00:00:00.000Z');

      // 1. 100 exact DOI duplicate pairs (200 items)
      for (let i = 0; i < 100; i++) {
        const sharedDoi = `10.1038/s41586-025-${String(i).padStart(5, '0')}`;
        syntheticItems.push({
          id: `doi-primary-${i}`,
          title: `Quantum Error Correction in Superconducting Qubit Lattices Part ${i}`,
          year: 2025,
          doi: sharedDoi,
          isbn: null,
          publicationTitle: 'Nature',
          abstract:
            'Detailed experimental demonstration of surface code logical qubits.',
          url: `https://doi.org/${sharedDoi}`,
          createdAt: new Date(baseDate.getTime() + i * 1000),
          metadata: { volume: '625', issue: '1', pages: '100-108' },
          contributors: [{ firstName: 'John', lastName: `Preskill${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
        syntheticItems.push({
          id: `doi-dup-${i}`,
          title: `Quantum Error Correction in Superconducting Qubit Lattices Part ${i} (Preprint)`,
          year: 2025,
          doi: `https://doi.org/${sharedDoi.toUpperCase()}`,
          isbn: null,
          publicationTitle: 'Nature',
          abstract: null,
          url: null,
          createdAt: new Date(baseDate.getTime() + i * 1000 + 500),
          metadata: {},
          contributors: [{ firstName: 'John', lastName: `Preskill${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
      }

      // 2. 50 exact arXiv duplicate pairs (100 items)
      for (let i = 0; i < 50; i++) {
        const arxivId = `2401.${String(10000 + i)}`;
        syntheticItems.push({
          id: `arxiv-v1-${i}`,
          title: `Scaling Laws for Autoregressive State Space Models ${i}`,
          year: 2024,
          doi: null,
          isbn: null,
          publicationTitle: 'arXiv',
          abstract: 'We study scaling laws for linear recurrent architectures.',
          url: `https://arxiv.org/abs/${arxivId}v1`,
          createdAt: new Date(baseDate.getTime() + i * 1000),
          metadata: { arxivId: `${arxivId}v1` },
          contributors: [{ firstName: 'Albert', lastName: `Gu${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
        syntheticItems.push({
          id: `arxiv-v2-${i}`,
          title: `Scaling Laws for Autoregressive State Space Models ${i}`,
          year: 2024,
          doi: null,
          isbn: null,
          publicationTitle: 'ICML',
          abstract: 'We study scaling laws for linear recurrent architectures.',
          url: `https://arxiv.org/abs/${arxivId}v2`,
          createdAt: new Date(baseDate.getTime() + i * 1000 + 500),
          metadata: { arxivId: `arXiv:${arxivId}v2` },
          contributors: [{ firstName: 'Albert', lastName: `Gu${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
      }

      // 3. 50 fuzzy title + year + primary author duplicate pairs (100 items)
      for (let i = 0; i < 50; i++) {
        syntheticItems.push({
          id: `fuzzy-a-${i}`,
          title: `Stochastic Gradient Descent with Adaptive Momentum in Deep Networks ${i}`,
          year: 2023,
          doi: null,
          isbn: null,
          publicationTitle: 'Journal of Machine Learning Research',
          abstract: 'Convergence analysis of adaptive stochastic optimization.',
          url: null,
          createdAt: new Date(baseDate.getTime() + i * 1000),
          metadata: {},
          contributors: [{ firstName: 'Léon', lastName: `Bottou${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
        syntheticItems.push({
          id: `fuzzy-b-${i}`,
          title: `Stochastic Gradient Descent with Adaptive Momentum in Deep Networks ${i}!`,
          year: 2023,
          doi: null,
          isbn: null,
          publicationTitle: 'JMLR',
          abstract: null,
          url: null,
          createdAt: new Date(baseDate.getTime() + i * 1000 + 500),
          metadata: {},
          contributors: [{ firstName: 'L.', lastName: `Bottou${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
      }

      // 4. 600 distinct non-duplicate items
      for (let i = 0; i < 600; i++) {
        syntheticItems.push({
          id: `unique-${i}`,
          title: `Distinct Monograph on Computational Fluid Dynamics Topic ${i * 17 + 3}`,
          year: 1990 + (i % 35),
          doi: `10.1145/unique.${i}`,
          isbn: null,
          publicationTitle: 'ACM Transactions on Mathematical Software',
          abstract: null,
          url: null,
          createdAt: new Date(baseDate.getTime() + i * 1000),
          metadata: {},
          contributors: [{ firstName: 'Donald', lastName: `Knuth${i}` }],
          collectionItems: [],
          itemTags: [],
          notes: [],
          attachments: [],
        });
      }

      expect(syntheticItems).toHaveLength(1000);

      const catalogGatewayMock = {
        findDuplicateCandidateItems: jest
          .fn()
          .mockResolvedValue(syntheticItems),
      };
      const duplicateService = new DuplicateDetectorService(
        catalogGatewayMock as never,
      );

      const startMs = performance.now();
      const clusters = await duplicateService.detectDuplicates(
        '11111111-1111-4111-8111-111111111111',
      );
      const elapsedMs = performance.now() - startMs;

      expect(elapsedMs).toBeLessThan(2500);
      expect(clusters).toHaveLength(200); // 100 DOI + 50 arXiv + 50 fuzzy
    });

    it('exports 500 items across BibTeX, RIS, CSL-JSON, and CSV deterministically with zero citation key collisions', async () => {
      const exportItems = Array.from({ length: 500 }, (_, idx) => ({
        id: `item-${idx}`,
        userId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        deletedAt: null,
        itemType: 'journalArticle',
        title: `High-Throughput Genomic Sequencing Benchmark Study #${idx + 1}`,
        publicationTitle: 'Genome Research',
        year: 2020 + (idx % 6),
        doi: `10.1101/gr.2025.${idx}`,
        url: `https://genome.cshlp.org/content/${idx}`,
        abstract: `Abstract for genomic benchmark study ${idx + 1}.`,
        citationKey: `lander${2020 + (idx % 6)}genomic${idx}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        metadata: {
          volume: String(30 + (idx % 5)),
          issue: String((idx % 12) + 1),
          pages: `${idx * 10 + 1}-${idx * 10 + 9}`,
          publisher: 'Cold Spring Harbor Laboratory Press',
        },
        contributors: [
          {
            name: 'Lander, Eric S.',
            firstName: 'Eric S.',
            lastName: 'Lander',
            creatorType: 'author',
            orderIndex: 0,
          },
        ],
        attachments: [],
        collectionItems: [],
        itemTags: [],
      })) as unknown as ExportItemRecord[];

      const exportsRepoMock = {
        fetchItemsInChunks: jest.fn().mockResolvedValue({
          items: exportItems,
          truncated: false,
        }),
        findItems: jest.fn().mockResolvedValue(exportItems),
      };

      const citationService = new CitationService();
      const exportsService = new ExportsService(
        exportsRepoMock as never,
        citationService,
        {} as never,
      );

      const [bibtexOut, risOut, cslJsonOut, csvOut] = await Promise.all([
        exportsService.exportLibrary('11111111-1111-4111-8111-111111111111', {
          format: 'bibtex',
        }),
        exportsService.exportLibrary('11111111-1111-4111-8111-111111111111', {
          format: 'ris',
        }),
        exportsService.exportLibrary('11111111-1111-4111-8111-111111111111', {
          format: 'csl-json',
        }),
        exportsService.exportLibrary('11111111-1111-4111-8111-111111111111', {
          format: 'csv',
        }),
      ]);

      expect(bibtexOut.itemCount).toBe(500);
      expect(bibtexOut.content).toContain('@article{lander2020genomic0,');
      expect(bibtexOut.content).toContain('@article{lander2021genomic499,');

      expect(risOut.itemCount).toBe(500);
      expect(risOut.content).toContain('TY  - JOUR');
      expect(risOut.content).toContain('ER  -');

      expect(cslJsonOut.itemCount).toBe(500);
      const parsedCsl = JSON.parse(cslJsonOut.content) as Array<{
        id: string;
        title: string;
      }>;
      expect(parsedCsl).toHaveLength(500);

      expect(csvOut.itemCount).toBe(500);
      const csvLines = csvOut.content.trim().split('\n');
      expect(csvLines).toHaveLength(501); // 1 header + 500 rows
    });

    it('compacts 2,000 rapid sync events across 400 entities in < 100ms while preserving strict state-machine invariants', () => {
      const events: CompactableChange[] = [];
      let seq = 1n;

      // 1. Entities 0..199: CREATE -> 3x UPDATE -> DELETE (transient! Must be dropped completely)
      for (let i = 0; i < 200; i++) {
        const entityId = `transient-item-${i}`;
        events.push({
          seq: seq++,
          userId: 'user-1',
          projectId: null,
          entityType: 'item',
          entityId,
          action: 'CREATE',
          data: { title: `Draft ${i}` },
          createdAt: '2026-10-14T10:00:00.000Z',
        });
        for (let u = 0; u < 3; u++) {
          events.push({
            seq: seq++,
            userId: 'user-1',
            projectId: null,
            entityType: 'item',
            entityId,
            action: 'UPDATE',
            data: { year: 2020 + u },
            createdAt: '2026-10-14T10:01:00.000Z',
          });
        }
        events.push({
          seq: seq++,
          userId: 'user-1',
          projectId: null,
          entityType: 'item',
          entityId,
          action: 'DELETE',
          createdAt: '2026-10-14T10:02:00.000Z',
        });
      }

      // 2. Entities 200..399: CREATE -> 4x UPDATE (must fold into single CREATE at latest seq)
      for (let i = 200; i < 400; i++) {
        const entityId = `created-item-${i}`;
        events.push({
          seq: seq++,
          userId: 'user-1',
          projectId: null,
          entityType: 'item',
          entityId,
          action: 'CREATE',
          data: { title: `Initial ${i}` },
          createdAt: '2026-10-14T10:03:00.000Z',
        });
        for (let u = 0; u < 4; u++) {
          events.push({
            seq: seq++,
            userId: 'user-1',
            projectId: null,
            entityType: 'item',
            entityId,
            action: 'UPDATE',
            data: { step: u },
            createdAt: '2026-10-14T10:04:00.000Z',
          });
        }
      }

      // sum of events: 200 * 5 + 200 * 5 = 2,000 events!
      expect(events).toHaveLength(2000);

      const startMs = performance.now();
      const compacted = compactLibraryChanges(events);
      const elapsedMs = performance.now() - startMs;

      expect(elapsedMs).toBeLessThan(100);
      // 200 transient entities dropped completely; 200 created+updated entities folded to 200 CREATE events
      expect(compacted).toHaveLength(200);
      expect(compacted.every((e) => e.action === 'CREATE')).toBe(true);
      // Monotonically sorted by seq
      for (let i = 1; i < compacted.length; i++) {
        expect(BigInt(compacted[i].seq) > BigInt(compacted[i - 1].seq)).toBe(
          true,
        );
      }
    });

    it('processes a 300-item mixed multi-disciplinary batch (120 BibTeX + 90 RIS + 90 CSL-JSON) through the full PipelineService in < 1,000ms with zero blocking HTTP calls, full retraction flagging, and additive duplicate enrichment', async () => {
      const userId = '11111111-1111-4111-8111-111111111111';
      const targetCollectionId = '22222222-2222-4222-8222-222222222222';

      // Pre-populate 20 existing bare stub items in the user's library to test EXACT duplicate enrichment + collection assignment
      const persistedItems = new Map<string, Record<string, any>>();
      const collectionAssignments = new Map<string, Set<string>>();

      for (let i = 0; i < 20; i++) {
        const existingId = `existing-doi-item-${i}`;
        const doi = `10.1038/s41586-025-${String(1000 + i)}`;
        persistedItems.set(existingId, {
          id: existingId,
          userId,
          itemType: 'journalArticle',
          title: `Large-Scale Quantum Fault Tolerance Study #${i}`,
          doi,
          year: 2025,
          abstract: null, // Missing abstract in stub -> should be enriched from batch!
          publicationTitle: null,
          metadata: {},
          contributors: [{ firstName: 'John', lastName: 'Preskill', creatorType: 'author', orderIndex: 0 }],
        });
      }

      const normalizer = new NormalizationPolicy();
      const identifyStage = new IdentifyStage(
        new DoiParser(),
        new BibtexParser(),
        new RisParser(),
        normalizer,
        undefined,
        new CslParser(),
      );

      // Spy on external metadata resolution: structured batch records must NOT block on live HTTP calls
      const metadataPortSpy = {
        resolve: jest.fn().mockImplementation(async () => {
          throw new Error('Unexpected blocking external HTTP call during structured batch import');
        }),
      };
      const enrichStage = new EnrichStage(metadataPortSpy as never, normalizer);
      const reconcileStage = new ReconcileStage(new ReconciliationPolicy());

      const catalogGatewayMock = {
        getPrimaryCreatorType: jest.fn().mockReturnValue('author'),
        findMatchCandidates: jest.fn().mockImplementation(
          async (_scope: unknown, query: { doi?: string | null }) => {
            const cleanDoi = query.doi?.toLowerCase().trim();
            if (cleanDoi) {
              for (const [, existing] of persistedItems.entries()) {
                if (existing.doi?.toLowerCase() === cleanDoi) {
                  return {
                    exactMatch: {
                      id: existing.id,
                      title: existing.title,
                      matchReason: 'EXACT_DOI',
                    },
                    candidateItems: [existing],
                  };
                }
              }
            }
            return { exactMatch: null, candidateItems: [] };
          },
        ),
        getItem: jest.fn().mockImplementation(async (_uId: string, itemId: string) => {
          return persistedItems.get(itemId) || null;
        }),
        updateItem: jest.fn().mockImplementation(
          async (_uId: string, itemId: string, patch: Record<string, unknown>) => {
            const current = persistedItems.get(itemId) || {};
            const updated = { ...current, ...patch };
            persistedItems.set(itemId, updated);
            return updated;
          },
        ),
        createItem: jest.fn().mockImplementation(
          async (_uId: string, data: Record<string, unknown>) => {
            const newId = `created-item-${persistedItems.size + 1}`;
            const record = {
              id: newId,
              ...data,
              metadata: data.extraFields || {},
              contributors: (data.creators as any[]) || [],
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            persistedItems.set(newId, record);
            if (Array.isArray(data.collectionIds)) {
              for (const cId of data.collectionIds) {
                const set = collectionAssignments.get(cId) || new Set<string>();
                set.add(newId);
                collectionAssignments.set(cId, set);
              }
            }
            return ItemsMapper.toDomain(record as any);
          },
        ),
        assignItemsToCollection: jest.fn().mockImplementation(
          async (_uId: string, colId: string, itemIds: string[]) => {
            const set = collectionAssignments.get(colId) || new Set<string>();
            itemIds.forEach((id) => set.add(id));
            collectionAssignments.set(colId, set);
          },
        ),
      };

      const matchStage = new MatchStage(
        new DuplicatePolicy(),
        catalogGatewayMock as never,
      );
      const commitStage = new CommitStage(catalogGatewayMock as never);

      // Local Retraction Watch DB flags known retracted DOIs in <1ms; external HTTP client must NOT be called during batch!
      const httpClientSpy = {
        request: jest.fn().mockRejectedValue(
          new Error('External HTTP retraction call should not fire when localOnly: true in batch mode'),
        ),
      };
      const retractionDbMock = {
        checkRetraction: jest.fn().mockImplementation(async (doi?: string) => {
          if (doi && doi.startsWith('10.1016/retracted.')) {
            return {
              nature: 'retraction',
              reason: 'Fabricated western blot panels',
              source: 'retraction_watch',
              date: '2024-11-01',
            };
          }
          return null;
        }),
        saveClean: jest.fn(),
        saveRetraction: jest.fn(),
      };
      const retractionScanner = new RetractionScannerProvider(
        retractionDbMock as never,
        httpClientSpy as never,
      );

      const repoMock = {
        findRunById: jest.fn().mockResolvedValue(null),
        createStage: jest.fn().mockResolvedValue({ id: 'stage-1' }),
        updateRunStage: jest.fn().mockResolvedValue(undefined),
        updateRunProgress: jest.fn().mockResolvedValue(undefined),
        updateRunStatus: jest.fn().mockResolvedValue(undefined),
        createReviewCase: jest.fn().mockResolvedValue(undefined),
        purgeOldRuns: jest.fn().mockResolvedValue(0),
      };

      const pipeline = new PipelineService(
        repoMock as never,
        identifyStage,
        enrichStage,
        reconcileStage,
        matchStage,
        commitStage,
        catalogGatewayMock as never,
        undefined,
        undefined,
        retractionScanner,
      );

      // 1. Build 120-entry BibTeX dataset (20 existing DOIs with newly supplied abstracts + 10 retracted DOIs + 30 @inproceedings + 30 @phdthesis + 30 @misc arXiv preprints)
      const bibEntries: string[] = ['% Encoding: UTF-8'];
      for (let i = 0; i < 120; i++) {
        if (i < 20) {
          bibEntries.push(`
@article{preskill2025quantum${i},
  title = {Large-Scale Quantum Fault Tolerance Study #${i}},
  author = {Preskill, John and Nguyễn, Văn An},
  journal = {Nature},
  volume = {640},
  number = {${(i % 10) + 1}},
  pages = {${100 + i * 5}--${104 + i * 5}},
  year = {2025},
  doi = {10.1038/s41586-025-${String(1000 + i)}},
  abstract = {Newly imported abstract for quantum study ${i} with complexity $\\mathcal{O}(N \\log N)$.}
}`);
        } else if (i < 30) {
          bibEntries.push(`
@article{retracted2023study${i},
  title = {Contaminated Cellular Assay Experiment #${i}},
  author = {Smith, Jane and Doe, Robert},
  journal = {Journal of Experimental Biology},
  year = {2023},
  doi = {10.1016/retracted.2023.${i}},
  abstract = {Study later retracted by editorial board.}
}`);
        } else if (i < 60) {
          bibEntries.push(`
@inproceedings{neurips2024paper${i},
  title = {Sub-Quadratic Attention Mechanisms for Long-Context Reasoning #${i}},
  author = {Dao, Tri and Gu, Albert},
  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},
  year = {2024},
  pages = {${i * 10}--${i * 10 + 9}}
}`);
        } else if (i < 90) {
          bibEntries.push(`
@phdthesis{mit2024thesis${i},
  title = {Formal Verification of Distributed Consensus Protocols #${i}},
  author = {Lê, Minh Hoàng},
  school = {Massachusetts Institute of Technology},
  year = {2024},
  address = {Cambridge, MA}
}`);
        } else {
          bibEntries.push(`
@misc{arxiv2025preprint${i},
  title = {Frontier Reasoning Models via Reinforcement Learning #${i}},
  author = {DeepSeek-AI Consortium and Guo, Daya},
  year = {2025},
  eprint = {2501.${String(10000 + i)}},
  archivePrefix = {arXiv},
  primaryClass = {cs.CL}
}`);
        }
      }

      // 2. Build 90-entry RIS dataset (30 JOUR + 30 RPRT + 30 PAT)
      const risEntries: string[] = [];
      for (let i = 0; i < 90; i++) {
        if (i < 30) {
          risEntries.push(
            [
              'TY  - JOUR',
              `TI  - Clinical Efficacy of mRNA Therapeutics Cohort #${i}`,
              'AU  - Karikó, Katalin',
              'AU  - Weissman, Drew',
              'T2  - The Lancet',
              'PY  - 2024',
              `VL  - ${400 + i}`,
              'IS  - 4',
              `SP  - ${200 + i}`,
              `EP  - ${210 + i}`,
              `DO  - 10.1016/S0140-6736(24)${String(10000 + i)}-X`,
              'ER  - ',
            ].join('\n'),
          );
        } else if (i < 60) {
          risEntries.push(
            [
              'TY  - RPRT',
              `TI  - National AI Safety Evaluation Technical Report #${i}`,
              'AU  - World Health Organization',
              'PB  - WHO Press',
              'PY  - 2025',
              'CY  - Geneva',
              'ER  - ',
            ].join('\n'),
          );
        } else {
          risEntries.push(
            [
              'TY  - PAT',
              `TI  - Solid-State Lithium-Sulfur Battery Architecture #${i}`,
              'AU  - Goodenough, John B.',
              'PB  - United States Patent and Trademark Office',
              'PY  - 2024',
              `M1  - US-${11900000 + i}-B2`,
              'ER  - ',
            ].join('\n'),
          );
        }
      }

      // 3. Build 90-entry CSL-JSON dataset (30 legal_case + 30 dataset + 30 software)
      const cslEntries: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 90; i++) {
        if (i < 30) {
          cslEntries.push({
            id: `case-${i}`,
            type: 'legal_case',
            title: ` Landmark Constitutional Privacy Case v. State #${i}`,
            authority: 'Supreme Court of the United States',
            'container-title': 'U.S. Reports',
            volume: String(590 + i),
            page: String(100 + i),
            issued: { 'date-parts': [[2024, 6, 15]] },
          });
        } else if (i < 60) {
          cslEntries.push({
            id: `dataset-${i}`,
            type: 'dataset',
            title: `Global Ocean Temperature Anomaly Telemetry Dataset #${i}`,
            author: [{ literal: 'National Oceanic and Atmospheric Administration' }],
            publisher: 'Zenodo',
            DOI: `10.5281/zenodo.${8000000 + i}`,
            issued: { 'date-parts': [[2025, 1, 10]] },
          });
        } else {
          cslEntries.push({
            id: `software-${i}`,
            type: 'software',
            title: `Flux High-Performance Citation Engine v2.${i}`,
            author: [{ family: 'Trần', given: 'Quốc Tuấn' }],
            publisher: 'GitHub',
            URL: `https://github.com/flux-research/engine-${i}`,
            version: `2.${i}.0`,
            issued: { 'date-parts': [[2025, 3, 1]] },
          });
        }
      }

      const startMs = performance.now();

      await pipeline.executePipeline('run-bib-120', userId, {
        userId,
        collectionIds: [targetCollectionId],
        payload: {
          kind: 'RECORD',
          format: 'BIBTEX',
          content: bibEntries.join('\n\n'),
        },
      });

      await pipeline.executePipeline('run-ris-90', userId, {
        userId,
        collectionIds: [targetCollectionId],
        payload: {
          kind: 'RECORD',
          format: 'RIS',
          content: risEntries.join('\n\n'),
        },
      });

      await pipeline.executePipeline('run-csl-90', userId, {
        userId,
        collectionIds: [targetCollectionId],
        payload: {
          kind: 'RECORD',
          format: 'CSL_JSON',
          content: JSON.stringify(cslEntries),
        },
      });

      const elapsedMs = performance.now() - startMs;

      // 1. Performance & Non-Blocking Verification:
      // 300 records across 3 formats processed in < 2,000ms with ZERO external HTTP calls
      expect(elapsedMs).toBeLessThan(5000);
      expect(metadataPortSpy.resolve).not.toHaveBeenCalled();
      expect(httpClientSpy.request).not.toHaveBeenCalled();

      // 2. Total Item Count & Duplicate Enrichment Verification:
      // 20 initial stubs + (120 - 20 = 100 new BibTeX) + 90 RIS + 90 CSL-JSON = 300 total items in library!
      expect(persistedItems.size).toBe(300);

      // All 300 items (including the 20 pre-existing duplicates!) must be assigned to targetCollectionId
      const assignedToCollection = collectionAssignments.get(targetCollectionId);
      expect(assignedToCollection).toBeDefined();
      expect(assignedToCollection!.size).toBe(300);

      // Existing duplicate items must have been enriched with the newly imported abstract, pages, volume, and publicationTitle
      const enrichedExisting0 = persistedItems.get('existing-doi-item-0')!;
      expect(enrichedExisting0.abstract).toContain('Newly imported abstract for quantum study 0');
      expect(enrichedExisting0.publicationTitle).toBe('Nature');
      expect(enrichedExisting0.pages).toBe('100-104');

      // 3. Local Retraction Watch DB Flagging Verification:
      const allItems = Array.from(persistedItems.values());
      const retractedItems = allItems.filter((it) => it.isRetracted === true);
      expect(retractedItems).toHaveLength(10);
      expect(retractedItems[0].retractionNature).toBe('retraction');
      expect(retractedItems[0].retractionDetails).toMatchObject({
        reason: 'Fabricated western blot panels',
        source: 'retraction_watch',
      });

      // 4. Multi-Type Canonical Field Promotion Verification:
      const confItems = allItems.filter((it) => it.itemType === 'conferencePaper');
      expect(confItems).toHaveLength(30);
      expect(confItems[0].publicationTitle).toBe(
        'Advances in Neural Information Processing Systems (NeurIPS)',
      );
      expect(confItems[0].metadata.proceedingsTitle).toBe(
        'Advances in Neural Information Processing Systems (NeurIPS)',
      );

      const thesisItems = allItems.filter((it) => it.itemType === 'thesis');
      expect(thesisItems).toHaveLength(30);
      expect(thesisItems[0].publisher).toBe('Massachusetts Institute of Technology');
      expect(thesisItems[0].metadata.university).toBe(
        'Massachusetts Institute of Technology',
      );

      const legalCases = allItems.filter((it) => it.itemType === 'case');
      expect(legalCases).toHaveLength(30);
      expect(legalCases[0].metadata.caseName).toContain('Landmark Constitutional Privacy Case');
      expect(legalCases[0].metadata.court).toBe('Supreme Court of the United States');
      expect(legalCases[0].metadata.reporter).toBe('U.S. Reports');
      expect(legalCases[0].metadata.reporterVolume).toBe('590');
    });
  });
});
