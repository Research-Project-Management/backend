import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Prisma, AnnotationType } from '@prisma/client';
import {
  parseAcademicFeedXml,
  promoteFeedEntryToLibrary,
  FeedPromotionCatalogPort,
} from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { DuplicateService } from '@/modules/library/ingestion/services/duplicate.service';
import { OcrProvider } from '@/modules/library/extraction/providers/ocr.provider';
import { OcrSandwichPdfService } from '@/modules/library/extraction/services/ocr-sandwich-pdf.service';
import { FullTextProvider } from '@/modules/library/search/services/full-text.provider';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotation.normalizer';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { AnnotationsService } from '@/modules/library/extraction/services/annotations.service';
import { PdfAnnotationImporterService } from '@/modules/library/extraction/services/pdf-annotation-importer.service';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { PdfBakerService } from '@/modules/library/citation/services/pdf-baker.service';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import { buildAnnotationSortIndex } from '@/modules/library/core';
import { fromPartial } from '@total-typescript/shoehorn';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import type { PrismaService } from '@/core';
import type {
  TransactionService,
  TransactionHelpers,
} from '@/modules/library/core';
import type { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import type { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import type {
  IItemExistencePort,
  IItemReadPort,
} from '@/modules/library/catalog/types/items.types';
import type { ExportsRepository } from '@/modules/library/citation/repositories/exports.repository';
import type { CitationService } from '@/modules/library/citation/services/citation.service';

describe('Wave 5 — Zotero 7 RSS/Atom Feeds, My Publications & License Guard, Scanned PDF OCR Sandwich Pipeline, and Embedded PDF Annotations', () => {
  const USER_A = '11111111-1111-4111-8111-111111111111';
  const USER_B = '22222222-2222-4222-8222-222222222222';
  const PROJECT_1 = '33333333-3333-4333-8333-333333333333';
  const COLLECTION_1 = '44444444-4444-4444-8444-444444444444';
  const ITEM_1 = '55555555-5555-4555-8555-555555555555';
  const ITEM_2 = '66666666-6666-4666-8666-666666666666';
  const ATTACHMENT_1 = '77777777-7777-4777-8777-777777777777';
  const CONTRIBUTOR_1 = '88888888-8888-4888-8888-888888888888';

  // USER STORY 1: Zotero RSS / Atom Feeds & ArXiv Daily Alerts
  describe('User Story 1: Zotero RSS 2.0, RDF/PRISM 1.0 & Atom Feeds Parsing and Library Promotion', () => {
    it('parses Atom 1.0 / ArXiv daily feed with CDATA, HTML stripping, categories, DOI/arXiv normalization, and license links', () => {
      const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
          <title>ArXiv Query: cat:cs.CL</title>
          <link href="http://arxiv.org/api/query?search_query=cat:cs.CL" rel="self" type="application/atom+xml"/>
          <updated>2026-03-15T00:00:00Z</updated>
          <entry>
            <id>http://arxiv.org/abs/2502.12345v2</id>
            <published>2026-02-18T14:22:10Z</published>
            <updated>2026-02-20T09:10:00Z</updated>
            <title><![CDATA[  Chain-of-Verification for <b>Autonomous</b> Research Agents (arXiv:2502.12345v2 [cs.CL])  ]]></title>
            <summary><![CDATA[<p>arXiv:2502.12345v2 Announce Type: new <br/>Abstract: We introduce a formal verification loop for multi-agent scientific discovery &amp; synthesis.</p>]]></summary>
            <author><name>Elena Rostova</name></author>
            <author><name>Marcus Vance</name></author>
            <link href="http://arxiv.org/abs/2502.12345v2" rel="alternate" type="text/html"/>
            <link title="pdf" href="http://arxiv.org/pdf/2502.12345v2" rel="related" type="application/pdf"/>
            <link title="license" href="http://creativecommons.org/licenses/by/4.0/" rel="related"/>
            <arxiv:primary_category term="cs.CL"/>
            <category term="cs.CL"/>
            <category term="cs.AI"/>
            <arxiv:doi>https://doi.org/10.48550/ARXIV.2502.12345</arxiv:doi>
          </entry>
        </feed>`;

      const feed = parseAcademicFeedXml(atomXml);
      expect(feed.format).toBe('atom');
      expect(feed.feedTitle).toBe('ArXiv Query: cat:cs.CL');
      expect(feed.entries).toHaveLength(1);

      const entry = feed.entries[0];
      expect(entry.title).toBe(
        'Chain-of-Verification for Autonomous Research Agents',
      );
      expect(entry.arxivId).toBe('2502.12345v2');
      expect(entry.doi).toBe('10.48550/arxiv.2502.12345');
      expect(entry.url).toBe('http://arxiv.org/abs/2502.12345v2');
      expect(entry.pdfUrl).toBe('http://arxiv.org/pdf/2502.12345v2');
      expect(entry.authors).toEqual(['Elena Rostova', 'Marcus Vance']);
      expect(entry.creators).toEqual([
        expect.objectContaining({
          firstName: 'Elena',
          lastName: 'Rostova',
          creatorType: 'author',
        }),
        expect.objectContaining({
          firstName: 'Marcus',
          lastName: 'Vance',
          creatorType: 'author',
        }),
      ]);
      expect(entry.abstract).toBe(
        'We introduce a formal verification loop for multi-agent scientific discovery & synthesis.',
      );
      expect(entry.publicationDate).toBe('2026-02-18');
      expect(entry.year).toBe(2026);
      expect(entry.primaryCategory).toBe('cs.CL');
      expect(entry.keywords).toEqual(
        expect.arrayContaining([
          'Computer Science - Computation and Language',
          'Computer Science - Artificial Intelligence',
        ]),
      );
      expect(entry.rights).toBe('CC-BY-4.0');
      expect(entry.itemType).toBe('preprint');
    });

    it('parses RDF / RSS 1.0 (Nature / Science / Oxford PRISM + Dublin Core) journal feeds', () => {
      const rdfXml = `<?xml version="1.0" encoding="UTF-8"?>
        <rdf:RDF
          xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns="http://purl.org/rss/1.0/"
          xmlns:dc="http://purl.org/dc/elements/1.1/"
          xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"
          xmlns:content="http://purl.org/rss/1.0/modules/content/">
          <channel rdf:about="https://www.nature.com/nature.rss">
            <title>Nature - Issue</title>
            <link>https://www.nature.com/nature</link>
          </channel>
          <item rdf:about="https://doi.org/10.1038/s41586-026-09999-1">
            <title><![CDATA[Quantum Error Correction Below the Fault-Tolerance Threshold]]></title>
            <link>https://www.nature.com/articles/s41586-026-09999-1</link>
            <content:encoded><![CDATA[<div><p>Demonstration of exponential logical error suppression in a surface code processor.</p><script>alert(1)</script></div>]]></content:encoded>
            <dc:creator>Chen, Lin</dc:creator>
            <dc:creator>Alvarez, Sofia</dc:creator>
            <dc:identifier>doi:10.1038/S41586-026-09999-1</dc:identifier>
            <dc:date>2026-01-29</dc:date>
            <dc:subject>Quantum Physics</dc:subject>
            <prism:publicationName>Nature</prism:publicationName>
            <prism:volume>637</prism:volume>
            <prism:number>8045</prism:number>
            <prism:startingPage>310</prism:startingPage>
            <prism:endingPage>318</prism:endingPage>
            <prism:coverDate>2026-01-29</prism:coverDate>
          </item>
        </rdf:RDF>`;

      const feed = parseAcademicFeedXml(rdfXml);
      expect(feed.format).toBe('rss1-rdf');
      expect(feed.feedTitle).toBe('Nature - Issue');
      expect(feed.entries).toHaveLength(1);

      const entry = feed.entries[0];
      expect(entry.title).toBe(
        'Quantum Error Correction Below the Fault-Tolerance Threshold',
      );
      expect(entry.doi).toBe('10.1038/s41586-026-09999-1');
      expect(entry.publicationTitle).toBe('Nature');
      expect(entry.volume).toBe('637');
      expect(entry.issue).toBe('8045');
      expect(entry.pages).toBe('310-318');
      expect(entry.year).toBe(2026);
      expect(entry.publicationDate).toBe('2026-01-29');
      expect(entry.abstract).toBe(
        'Demonstration of exponential logical error suppression in a surface code processor.',
      );
      expect(entry.creators).toEqual([
        expect.objectContaining({ firstName: 'Lin', lastName: 'Chen' }),
        expect.objectContaining({ firstName: 'Sofia', lastName: 'Alvarez' }),
      ]);
      expect(entry.itemType).toBe('journalArticle');
    });

    it('promotes a feed item into Personal Library (projectId: null) or Project Library with duplicate guard', async () => {
      const rss2Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <title>arXiv cs.LG daily</title>
            <link>https://rss.arxiv.org/rss/cs.LG</link>
            <item>
              <title>Scaling Laws for Test-Time Compute</title>
              <link>https://arxiv.org/abs/2601.54321</link>
              <description><![CDATA[arXiv:2601.54321v1 Announce Type: new Abstract: Optimal allocation of inference compute improves reasoning accuracy.]]></description>
              <dc:creator>Ada Lovelace and Alan Turing</dc:creator>
              <pubDate>Wed, 11 Feb 2026 05:00:00 GMT</pubDate>
              <category>cs.LG</category>
            </item>
          </channel>
        </rss>`;

      const feed = parseAcademicFeedXml(rss2Xml);
      expect(feed.format).toBe('rss2');
      expect(feed.entries).toHaveLength(1);

      const entry = feed.entries[0];
      expect(entry.arxivId).toBe('2601.54321v1');
      expect(entry.doi).toBe('10.48550/arXiv.2601.54321');
      expect(entry.pdfUrl).toBe('https://arxiv.org/pdf/2601.54321.pdf');

      const storedItems: Array<{
        id: string;
        title: string;
        doi?: string;
        arxivId?: string;
        projectId?: string | null;
        collectionIds?: string[];
      }> = [];

      const mockCatalogPort: FeedPromotionCatalogPort = {
        findExistingByIdentifier: jest.fn(async (_userId, params) => {
          const found = storedItems.find(
            (it) =>
              (it.projectId ?? undefined) === params.projectId &&
              ((params.doi && it.doi === params.doi) ||
                (params.arxivId && it.arxivId === params.arxivId)),
          );
          return found ? { id: found.id, title: found.title } : null;
        }),
        createItem: jest.fn(async (_userId, data) => {
          const created = {
            id: `item-${storedItems.length + 1}`,
            title: data.title,
            doi: data.doi,
            arxivId: data.metadata?.arxivId as string | undefined,
            projectId: data.projectId ?? null,
            collectionIds: data.collectionIds,
          };
          storedItems.push(created);
          return created;
        }),
      };

      // 1. Promote to Personal Library ("personal" normalizes to undefined / null projectId)
      const firstPromotion = await promoteFeedEntryToLibrary(
        entry,
        USER_A,
        mockCatalogPort,
        { projectId: 'personal', tags: ['to-read'] },
      );
      expect(firstPromotion.deduplicated).toBe(false);
      expect(firstPromotion.item.projectId).toBeNull();

      // 2. Promoting the same feed entry again into Personal Library triggers duplicate guard
      const secondPromotion = await promoteFeedEntryToLibrary(
        entry,
        USER_A,
        mockCatalogPort,
        { projectId: undefined },
      );
      expect(secondPromotion.deduplicated).toBe(true);
      expect(secondPromotion.item.id).toBe(firstPromotion.item.id);
      expect(mockCatalogPort.createItem).toHaveBeenCalledTimes(1);

      // 3. Promoting the same feed entry into a Project Library (isolated scope) creates a project item
      const projectPromotion = await promoteFeedEntryToLibrary(
        entry,
        USER_A,
        mockCatalogPort,
        { projectId: PROJECT_1, collectionId: COLLECTION_1 },
      );
      expect(projectPromotion.deduplicated).toBe(false);
      expect(projectPromotion.item.projectId).toBe(PROJECT_1);
      expect(mockCatalogPort.createItem).toHaveBeenCalledTimes(2);
    });
  });

  // USER STORY 2: Zotero "My Publications" Lifecycle & Open Access License Guard
  describe('User Story 2: Zotero "My Publications" Lifecycle, Open Access License Guard & Duplicate Merge', () => {
    it('adds an item to My Publications with authorship confirmation, Open Access license (CC-BY-4.0), and removes it from My Publications without trashing the item', async () => {
      const userPublicationsStore = new Map<
        string,
        {
          userId: string;
          itemId: string;
          contributorId?: string | null;
          isPublic: boolean;
          openAccessLicense?: string | null;
        }
      >();

      let currentItemRecord: Record<string, unknown> = {
        id: ITEM_1,
        userId: USER_A,
        projectId: null,
        title: 'Neural Symbolic Theorem Proving',
        itemType: 'journalArticle',
        year: 2026,
        doi: '10.1145/3600000.3600001',
        url: null,
        abstract: 'Abstract text',
        publicationTitle: 'Journal of Automated Reasoning',
        citationKey: 'rostova2026neural',
        metadata: {},
        version: 1,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        collectionItems: [],
        itemTags: [],
        contributors: [
          {
            id: CONTRIBUTOR_1,
            itemId: ITEM_1,
            creatorType: 'author',
            firstName: 'Elena',
            lastName: 'Rostova',
            fullName: 'Elena Rostova',
            orderIndex: 0,
          },
        ],
        attachments: [],
      };

      const mockTxClient = {
        item: {
          findFirst: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) => {
              if (where.id === ITEM_1 && where.userId === USER_A) {
                return currentItemRecord;
              }
              return null;
            },
          ),
          update: jest.fn(
            async ({ data }: { data: Record<string, unknown> }) => {
              currentItemRecord = {
                ...currentItemRecord,
                metadata: data.metadata,
                version: (currentItemRecord.version as number) + 1,
              };
              return currentItemRecord;
            },
          ),
        },
        userPublication: {
          upsert: jest.fn(
            async ({
              where,
              create,
              update,
            }: {
              where: { userId_itemId: { userId: string; itemId: string } };
              create: Record<string, unknown>;
              update: Record<string, unknown>;
            }) => {
              const key = `${where.userId_itemId.userId}:${where.userId_itemId.itemId}`;
              const existing = userPublicationsStore.get(key);
              const next = existing
                ? { ...existing, ...update }
                : {
                    userId: where.userId_itemId.userId,
                    itemId: where.userId_itemId.itemId,
                    isPublic: Boolean(create.isPublic),
                    contributorId:
                      (create.contributorId as string | null) ?? null,
                    openAccessLicense:
                      (create.openAccessLicense as string | null) ?? null,
                  };
              userPublicationsStore.set(key, next);
              return next;
            },
          ),
          deleteMany: jest.fn(
            async ({
              where,
            }: {
              where: { userId: string; itemId: string };
            }) => {
              const key = `${where.userId}:${where.itemId}`;
              const deleted = userPublicationsStore.delete(key);
              return { count: deleted ? 1 : 0 };
            },
          ),
        },
      };

      const commandRepo = new CommandRepository(
        mockTxClient as unknown as PrismaService,
      );
      const mockLibraryTx = {
        executeInTransaction: jest.fn(
          async <T>(
            fn: (
              tx: Prisma.TransactionClient,
              helpers: TransactionHelpers,
            ) => Promise<T>,
          ) => {
            const helpers: TransactionHelpers = {
              appendChange: jest.fn(async () => undefined) as any,
              publishOutbox: jest.fn(async () => undefined) as any,
              recordTombstone: jest.fn(async () => undefined) as any,
            };
            return fn(
              mockTxClient as unknown as Prisma.TransactionClient,
              helpers,
            );
          },
        ),
      } as unknown as TransactionService;

      const itemService = new ItemService(
        {} as unknown as QueryRepository,
        commandRepo,
        mockLibraryTx,
        {} as unknown as any,
        {} as unknown as any,
      );

      // Step 1: Mark as My Publication with CC-BY-4.0 license and authorship verification
      const addedResult = await itemService.setMyPublication(
        USER_A,
        ITEM_1,
        true,
        {
          contributorId: CONTRIBUTOR_1,
          isPublic: true,
          openAccessLicense: 'CC-BY-4.0',
          includeAttachments: true,
          includeNotes: false,
          authorshipConfirmed: true,
        },
      );

      expect(addedResult.metadata).toEqual(
        expect.objectContaining({
          isMyPublication: true,
          openAccessLicense: 'CC-BY-4.0',
          isPublicPublication: true,
          publicationContributorId: CONTRIBUTOR_1,
          includeAttachmentsInMyPublications: true,
          includeNotesInMyPublications: false,
          authorshipConfirmed: true,
        }),
      );
      expect(userPublicationsStore.get(`${USER_A}:${ITEM_1}`)).toEqual({
        userId: USER_A,
        itemId: ITEM_1,
        contributorId: CONTRIBUTOR_1,
        isPublic: true,
        openAccessLicense: 'CC-BY-4.0',
      });

      // Step 2: Update license to CC0-1.0
      await itemService.setMyPublication(USER_A, ITEM_1, true, {
        openAccessLicense: 'CC0-1.0',
      });
      expect(
        userPublicationsStore.get(`${USER_A}:${ITEM_1}`)?.openAccessLicense,
      ).toBe('CC0-1.0');

      // Step 3: Remove from My Publications -> userPublication row deleted, but item remains in Personal Library (deletedAt === null)
      const removedResult = await itemService.setMyPublication(
        USER_A,
        ITEM_1,
        false,
      );
      expect(removedResult.metadata).toEqual(
        expect.objectContaining({
          isMyPublication: false,
        }),
      );
      expect(userPublicationsStore.has(`${USER_A}:${ITEM_1}`)).toBe(false);
      expect(currentItemRecord.deletedAt).toBeNull();
    });

    it('filters my-publications view in QueryRepository and consolidates UserPublication + Open Access license during DuplicateService.mergeDuplicates', async () => {
      // 1. Verify QueryRepository buildWhereClause for view: 'my-publications'
      const mockPrismaForQuery = {
        item: {
          findMany: jest.fn(async () => []),
          count: jest.fn(async () => 0),
        },
      };
      const queryRepo = new QueryRepository(
        mockPrismaForQuery as unknown as PrismaService,
      );
      await queryRepo.findMany(USER_A, { view: 'my-publications', limit: 20 });

      expect(mockPrismaForQuery.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER_A,
            projectId: null,
            deletedAt: null,
            AND: expect.arrayContaining([
              {
                OR: [
                  {
                    metadata: {
                      path: ['isMyPublication'],
                      equals: true,
                    },
                  },
                  { publications: { some: { userId: USER_A } } },
                ],
              },
            ]),
          }),
        }),
      );

      // 2. Verify DuplicateService.mergeDuplicates consolidates UserPublication and metadata.isMyPublication onto primary item
      let updatedPrimaryData: Record<string, unknown> | null = null;
      const upsertedPrimaryPubs: Array<Record<string, unknown>> = [];
      const deletedDupPubs: Array<Record<string, unknown>> = [];

      const mockMergeTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: {
          findMany: jest.fn(async () => []),
        },
        userPublication: {
          findMany: jest.fn(async () => [
            {
              userId: USER_A,
              itemId: ITEM_2,
              contributorId: CONTRIBUTOR_1,
              isPublic: true,
              openAccessLicense: 'arXiv.org perpetual, non-exclusive license',
              addedAt: new Date('2026-01-15T00:00:00Z'),
            },
          ]),
          findUnique: jest.fn(async () => null),
          create: jest.fn(
            async ({ data }: { data: Record<string, unknown> }) => {
              upsertedPrimaryPubs.push(data);
              return data;
            },
          ),
          update: jest.fn(
            async ({ data }: { data: Record<string, unknown> }) => {
              upsertedPrimaryPubs.push(data);
              return data;
            },
          ),
          delete: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) => {
              deletedDupPubs.push(where);
              return where;
            },
          ),
        },
        itemMetadata: {
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        contributor: {
          count: jest.fn(async () => 1),
        },
        item: {
          update: jest.fn(
            async ({ data }: { data: Record<string, unknown> }) => {
              updatedPrimaryData = data;
              return {
                id: ITEM_1,
                version: 2,
                ...data,
              };
            },
          ),
          updateMany: jest.fn(async () => ({ count: 1 })),
          findUnique: jest.fn(async () => ({
            id: ITEM_1,
            userId: USER_A,
            projectId: null,
            itemType: 'preprint',
            title: 'Scaling Verification Agents',
            year: 2026,
            doi: '10.48550/arxiv.2502.12345',
            citationKey: 'rostova2026scaling',
            metadata: updatedPrimaryData?.metadata ?? {},
            version: 2,
            deletedAt: null,
            contributors: [],
            collectionItems: [],
            itemTags: [],
            attachments: [],
          })),
        },
      };

      const mockCatalogGateway = {
        findByIds: jest.fn(async () => [
          {
            id: ITEM_1,
            userId: USER_A,
            projectId: null,
            itemType: 'preprint',
            title: 'Scaling Verification Agents',
            year: 2026,
            doi: '10.48550/arxiv.2502.12345',
            citationKey: 'rostova2026scaling',
            metadata: {},
            version: 1,
            deletedAt: null,
          },
          {
            id: ITEM_2,
            userId: USER_A,
            projectId: null,
            itemType: 'preprint',
            title: 'Scaling Verification Agents',
            year: 2026,
            doi: '10.48550/arxiv.2502.12345',
            citationKey: 'rostova2026scaling_v1',
            metadata: {
              isMyPublication: true,
              openAccessLicense: 'arXiv.org perpetual, non-exclusive license',
              isPublicPublication: true,
              publicationConfirmedAt: '2026-01-15T00:00:00.000Z',
            },
            version: 1,
            deletedAt: null,
          },
        ]),
        mergeItems: jest.fn(async () => undefined),
      };

      const duplicateService = new DuplicateService(
        {
          executeInTransaction: jest.fn(
            async <T>(
              fn: (
                tx: Prisma.TransactionClient,
                helpers: TransactionHelpers,
              ) => Promise<T>,
            ) =>
              fn(mockMergeTx as unknown as Prisma.TransactionClient, {
                appendChange: jest.fn(async () => undefined) as any,
                publishOutbox: jest.fn(async () => undefined) as any,
                recordTombstone: jest.fn(async () => undefined) as any,
              }),
          ),
        } as unknown as TransactionService,
        mockCatalogGateway as unknown as ConstructorParameters<
          typeof DuplicateService
        >[1],
      );

      await duplicateService.mergeDuplicates(USER_A, {
        primaryItemId: ITEM_1,
        duplicateItemIds: [ITEM_2],
      });

      expect(upsertedPrimaryPubs).toHaveLength(1);
      expect(upsertedPrimaryPubs[0]).toEqual(
        expect.objectContaining({
          userId: USER_A,
          itemId: ITEM_1,
          contributorId: CONTRIBUTOR_1,
          isPublic: true,
          openAccessLicense: 'arXiv.org perpetual, non-exclusive license',
        }),
      );
      expect(deletedDupPubs).toHaveLength(1);
      expect(updatedPrimaryData).toBeDefined();
      const mergedMeta = (
        updatedPrimaryData as unknown as { metadata: Record<string, unknown> }
      ).metadata;
      expect(mergedMeta.isMyPublication).toBe(true);
      expect(mergedMeta.openAccessLicense).toBe(
        'arXiv.org perpetual, non-exclusive license',
      );
      expect(mergedMeta.isPublicPublication).toBe(true);
    });
  });

  // USER STORY 3: Scanned PDF Detection, OCR Sandwich PDF & Full-Text Search
  describe('User Story 3: Scanned PDF Detection, OCR Sandwich PDF Injection & Full-Text Page Anchor Indexing', () => {
    it('classifies image-only (< 32 chars), hybrid (< 150 chars + image operator), and born-digital pages accurately', async () => {
      const ocrProvider = new OcrProvider();

      // 1. Image-only scanned page (empty text layer)
      const scannedResult = await ocrProvider.detectScannedPage({
        pageNumber: 1,
        getTextContent: async () => ({ items: [{ str: '   ' }] }),
      });
      expect(scannedResult.isScanned).toBe(true);
      expect(scannedResult.isHybrid).toBe(false);
      expect(scannedResult.pageIndex).toBe(0);

      // 2. Hybrid page (short running header + scanned body image operator 85 = paintImageXObject)
      const hybridResult = await ocrProvider.detectScannedPage({
        pageNumber: 2,
        getTextContent: async () => ({
          items: [
            {
              str: 'Journal of Historical Manuscripts — Vol. 12 (1974), Page 42',
            },
          ],
        }),
        getOperatorList: async () => ({ fnArray: [10, 85, 22] }),
      });
      expect(hybridResult.isScanned).toBe(false);
      expect(hybridResult.isHybrid).toBe(true);
      expect(hybridResult.hasLargeImage).toBe(true);
      expect(hybridResult.pageIndex).toBe(1);

      // 3. Born-digital page (>= 150 chars of native text)
      const digitalText =
        'We present a comprehensive empirical evaluation of transformer-based retrieval architectures across multilingual scientific corpora, demonstrating statistically significant improvements in recall and mean reciprocal rank.';
      const digitalResult = await ocrProvider.detectScannedPage({
        pageNumber: 3,
        getTextContent: async () => ({ items: [{ str: digitalText }] }),
      });
      expect(digitalResult.isScanned).toBe(false);
      expect(digitalResult.isHybrid).toBe(false);
      expect(digitalResult.textLength).toBeGreaterThanOrEqual(150);
    });

    it('embeds an invisible searchable OCR text layer into a scanned PDF (Sandwich PDF) and indexes page anchors for FullTextProvider search', async () => {
      // Create a minimal 1-page PDF representing a scanned page
      const rawDoc = await PDFDocument.create();
      rawDoc.addPage([612, 792]);
      const originalPdfBytes = await rawDoc.save();
      const originalBuffer = Buffer.from(originalPdfBytes);

      const sandwichService = new OcrSandwichPdfService();
      const searchableBuffer = await sandwichService.generateSearchablePdf(
        originalBuffer,
        [
          {
            pageIndex: 0,
            text: 'Bayesian Nonparametric Inference in Neuroimaging',
            confidence: 94.5,
            orientationAngle: 0,
            skewAngle: -0.8,
            preprocessed: true,
            executionTimeMs: 120,
            wasOcr: true,
            imageWidth: 1224,
            imageHeight: 1584,
            blocks: [],
            words: [
              {
                text: 'Bayesian',
                confidence: 96,
                bbox: { x0: 120, y0: 200, x1: 260, y1: 236 },
              },
              {
                text: 'Nonparametric',
                confidence: 93,
                bbox: { x0: 275, y0: 200, x1: 490, y1: 236 },
              },
              {
                text: 'Inference',
                confidence: 95,
                bbox: { x0: 505, y0: 200, x1: 650, y1: 236 },
              },
              {
                text: 'in',
                confidence: 97,
                bbox: { x0: 665, y0: 200, x1: 700, y1: 236 },
              },
              {
                text: 'Neuroimaging',
                confidence: 92,
                bbox: { x0: 715, y0: 200, x1: 930, y1: 236 },
              },
            ],
          },
        ],
      );

      expect(Buffer.isBuffer(searchableBuffer)).toBe(true);
      expect(searchableBuffer.length).toBeGreaterThan(originalBuffer.length);

      // Verify the generated Sandwich PDF is valid and retains its page structure
      const reloadedDoc = await PDFDocument.load(searchableBuffer);
      expect(reloadedDoc.getPageCount()).toBe(1);

      // Index the OCR'd page text via FullTextProvider and verify searchPageAnchors
      const indexedRows: Array<{
        attachmentId: string;
        pageIndex: number;
        textContent: string;
        charOffset: number;
      }> = [];

      const mockFullTextPrisma = {
        $transaction: jest.fn(
          async <T>(fn: (tx: Record<string, unknown>) => Promise<T>) =>
            fn({
              fullTextIndex: {
                deleteMany: jest.fn(async () => ({ count: 0 })),
                createMany: jest.fn(
                  async ({
                    data,
                  }: {
                    data: Array<{
                      attachmentId: string;
                      pageIndex: number;
                      textContent: string;
                      charOffset: number;
                    }>;
                  }) => {
                    indexedRows.push(...data);
                    return { count: data.length };
                  },
                ),
              },
            }),
        ),
        fullTextIndex: {
          findMany: jest.fn(async () => indexedRows),
        },
      };

      const fullTextProvider = new FullTextProvider(
        new SearchRepository(mockFullTextPrisma as unknown as PrismaService),
      );

      await fullTextProvider.indexAttachmentPages(ATTACHMENT_1, [
        {
          pageIndex: 0,
          textContent:
            'Bayesian Nonparametric Inference in Neuroimaging provides flexible priors over infinite-dimensional spaces.',
          charOffset: 0,
        },
      ]);

      const matches = await fullTextProvider.searchPageAnchors(
        ATTACHMENT_1,
        'nonparametric inference',
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual(
        expect.objectContaining({
          attachmentId: ATTACHMENT_1,
          pageIndex: 0,
          charOffsetStart: 9,
          charOffsetEnd: 32,
        }),
      );
      expect(matches[0].snippet).toContain(
        'Bayesian Nonparametric Inference in Neuroimaging',
      );
    });
  });

  // USER STORY 4: Zotero Embedded PDF Annotations Import & Annotated Export
  describe('User Story 4: Embedded PDF Annotations Import Deduplication, Reading-Order Note Extraction & Annotated PDF Export', () => {
    it('imports embedded PDF annotations via PdfAnnotationImporterService, preserves normalized rectCoords through AnnotationNormalizer, and deduplicates on repeated imports', async () => {
      const storedAnnotations: Array<{
        id: string;
        attachmentId: string;
        type: AnnotationType;
        pageIndex: number;
        annotationSortIndex: string | null;
        color: string;
        quoteText: string | null;
        comment: string | null;
        tags: string[];
        rectCoords: unknown;
        authorId: string;
        version: number;
        deletedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }> = [];

      const mockAnnotPrisma = {
        annotation: {
          findMany: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) =>
              storedAnnotations.filter(
                (a) =>
                  a.attachmentId === where.attachmentId && a.deletedAt === null,
              ),
          ),
          create: jest.fn(
            async ({ data }: { data: Record<string, unknown> }) => {
              const entity = {
                id: `ann-${storedAnnotations.length + 1}`,
                attachmentId: data.attachmentId as string,
                type: data.type as AnnotationType,
                pageIndex: data.pageIndex as number,
                annotationSortIndex:
                  (data.annotationSortIndex as string | null) ?? null,
                color: data.color as string,
                quoteText: (data.quoteText as string | null) ?? null,
                comment: (data.comment as string | null) ?? null,
                tags: (data.tags as string[]) ?? [],
                rectCoords: data.rectCoords,
                authorId: data.authorId as string,
                version: 1,
                deletedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              storedAnnotations.push(entity);
              return entity;
            },
          ),
        },
      };

      const annotationsRepo = new AnnotationsRepository(
        mockAnnotPrisma as unknown as PrismaService,
      );
      const normalizer = new AnnotationNormalizer();
      const mockAttachmentsService = {
        assertAttachmentExists: jest.fn(async () => ({
          id: ATTACHMENT_1,
          itemId: ITEM_1,
          item: { id: ITEM_1, userId: USER_A, projectId: PROJECT_1 },
        })),
      } as unknown as AttachmentsService;

      const mockTxService = {
        executeInTransaction: jest.fn(
          async <T>(
            fn: (
              tx: Prisma.TransactionClient,
              helpers: TransactionHelpers,
            ) => Promise<T>,
          ) =>
            fn(mockAnnotPrisma as unknown as Prisma.TransactionClient, {
              appendChange: jest.fn(async () => undefined) as any,
              publishOutbox: jest.fn(async () => undefined) as any,
              recordTombstone: jest.fn(async () => undefined) as any,
            }),
        ),
      } as unknown as TransactionService;

      const annotationsService = new AnnotationsService(
        annotationsRepo,
        mockTxService,
        mockAttachmentsService,
        normalizer,
      );

      const mockAttachmentsRepo = {
        findUnique: jest.fn(async () => ({
          id: ATTACHMENT_1,
          itemId: ITEM_1,
          fileId: 'file-pdf-1',
          deletedAt: null,
          item: { id: ITEM_1, userId: USER_A, projectId: PROJECT_1 },
        })),
      };

      const mockStoragePort = {
        readOwnedFile: jest.fn(async () => ({
          buffer: Buffer.from('%PDF-1.7 mock'),
        })),
      };

      const importer = new PdfAnnotationImporterService(
        annotationsRepo,
        mockAttachmentsRepo as unknown as ConstructorParameters<
          typeof PdfAnnotationImporterService
        >[1],
        mockStoragePort as unknown as ConstructorParameters<
          typeof PdfAnnotationImporterService
        >[2],
        annotationsService,
        mockAttachmentsService,
      );

      // Spy on loadPdfDocument to simulate a 1-page PDF with 2 embedded annotations (Highlight + Text Sticky Note)
      jest
        .spyOn(
          importer as unknown as {
            loadPdfDocument: (data: Uint8Array) => Promise<unknown>;
          },
          'loadPdfDocument',
        )
        .mockResolvedValue({
          numPages: 1,
          getPage: async () => ({
            view: [0, 0, 612, 792],
            getViewport: () => ({ width: 612, height: 792 }),
            getAnnotations: async () => [
              {
                subtype: 'Highlight',
                rect: [72, 650, 420, 668],
                color: [255, 212, 0],
                contents:
                  'Sparse attention reduces quadratic memory complexity.',
              },
              {
                subtype: 'Text',
                rect: [72, 500, 96, 524],
                color: [46, 168, 229],
                contentsObj: { str: 'Compare with FlashAttention-3 benchmark' },
              },
            ],
          }),
        });

      // First import run: imports both embedded PDF annotations
      const firstRun = await importer.importFromAttachment(
        USER_A,
        ATTACHMENT_1,
      );
      expect(firstRun).toEqual({
        imported: 2,
        totalFound: 2,
        pagesScanned: 1,
      });
      expect(storedAnnotations).toHaveLength(2);
      expect(Array.isArray(storedAnnotations[0].rectCoords)).toBe(true);

      // Second import run on the same PDF: must deduplicate 100% of existing annotations!
      const secondRun = await importer.importFromAttachment(
        USER_A,
        ATTACHMENT_1,
      );
      expect(secondRun).toEqual({
        imported: 0,
        totalFound: 2,
        pagesScanned: 1,
      });
      expect(storedAnnotations).toHaveLength(2);
    });

    it('extracts structured Markdown notes sorted in reading order (page -> Y -> X) and burns annotations into exported PDF with scope isolation', async () => {
      // 1. Verify NotesService.extractNotesFromAnnotations sorts by pageIndex -> Y -> X and formats Zotero/Flux deep links
      const unsortedAnnotations = [
        {
          id: 'ann-bottom',
          attachmentId: ATTACHMENT_1,
          pageIndex: 0,
          annotationSortIndex: buildAnnotationSortIndex(0, 0.75, 0.15),
          color: '#ff6666',
          quoteText: 'Second highlight lower on page 1.',
          comment: 'Critical limitation',
          createdAt: new Date('2026-03-01T10:00:00Z'),
        },
        {
          id: 'ann-top',
          attachmentId: ATTACHMENT_1,
          pageIndex: 0,
          annotationSortIndex: buildAnnotationSortIndex(0, 0.2, 0.1),
          color: '#ffd400',
          quoteText: 'First highlight at top of page 1.',
          comment: null,
          createdAt: new Date('2026-03-01T10:05:00Z'),
        },
      ];

      let createdNotePayload: Record<string, unknown> | null = null;
      const mockNotesRepo = {
        findItemAnnotations: jest.fn(async () => unsortedAnnotations),
        create: jest.fn(
          async (_userId: string, data: Record<string, unknown>) => {
            createdNotePayload = data;
            return {
              id: 'note-1',
              version: 1,
              ...data,
            };
          },
        ),
      } as unknown as NotesRepository;

      const mockItemReadPort: IItemReadPort = fromPartial<IItemReadPort>({
        findById: jest.fn(
          async (userId: string, itemId: string, projectId?: string) => {
            // Enforce personal vs project scope isolation
            if (
              userId === USER_A &&
              itemId === ITEM_1 &&
              projectId === PROJECT_1
            ) {
              return {
                id: ITEM_1,
                userId: USER_A,
                projectId: PROJECT_1,
                title: 'Sparse Attention Mechanisms',
                year: 2026,
                doi: '10.1145/sparse.2026',
                citekey: 'rostova2026sparse',
                creators: [{ firstName: 'Elena', lastName: 'Rostova' }],
              } as unknown as Awaited<ReturnType<IItemReadPort['findById']>>;
            }
            return null;
          },
        ),
      });

      const mockItemExistencePort: IItemExistencePort =
        fromPartial<IItemExistencePort>({
          exists: jest.fn(async () => true),
        });

      const notesService = new NotesService(
        mockNotesRepo,
        {
          executeInTransaction: jest.fn(
            async <T>(
              fn: (
                tx: Prisma.TransactionClient,
                helpers: TransactionHelpers,
              ) => Promise<T>,
            ) =>
              fn({} as unknown as Prisma.TransactionClient, {
                appendChange: jest.fn(async () => undefined) as any,
                publishOutbox: jest.fn(async () => undefined) as any,
                recordTombstone: jest.fn(async () => undefined) as any,
              }),
          ),
        } as unknown as TransactionService,
        mockItemExistencePort,
        mockItemReadPort,
      );

      // Wrong scope (USER_B) is rejected
      await expect(
        notesService.extractNotesFromAnnotations(USER_B, ITEM_1, {
          projectId: PROJECT_1,
        }),
      ).rejects.toThrow(/not found/i);

      // Valid project scope extracts Markdown note in top-to-bottom reading order
      const extracted = await notesService.extractNotesFromAnnotations(
        USER_A,
        ITEM_1,
        {
          projectId: PROJECT_1,
          protocol: 'zotero',
        },
      );

      expect(extracted.success).toBe(true);
      expect(extracted.totalExtracted).toBe(2);
      const md = (createdNotePayload as unknown as { contentMd: string })
        .contentMd;
      const topIdx = md.indexOf('First highlight at top of page 1.');
      const bottomIdx = md.indexOf('Second highlight lower on page 1.');
      expect(topIdx).toBeGreaterThan(-1);
      expect(bottomIdx).toBeGreaterThan(topIdx);
      expect(md).toContain(
        `zotero://open-pdf/0_${ATTACHMENT_1}/1?annotation=ann-top`,
      );

      // 2. Verify ExportsService.exportAnnotatedItemPdf burns normalized rectCoords into PDF binary
      const basePdf = await PDFDocument.create();
      basePdf.addPage([612, 792]);
      const rawPdfBuffer = Buffer.from(await basePdf.save());

      const mockExportsRepo = {
        findItemById: jest.fn(
          async (userId: string, itemId: string, projectId?: string) => {
            if (
              userId !== USER_A ||
              itemId !== ITEM_1 ||
              projectId !== PROJECT_1
            ) {
              return null;
            }
            return {
              id: ITEM_1,
              title: 'Sparse Attention Mechanisms',
              attachments: [
                {
                  id: ATTACHMENT_1,
                  mimeType: 'application/pdf',
                  annotations: [
                    {
                      pageIndex: 0,
                      color: '#ffd400',
                      comment: 'Key theorem on page 1',
                      rectCoords: [
                        {
                          x1: 0.12,
                          y1: 0.18,
                          x2: 0.68,
                          y2: 0.21,
                          width: 0.56,
                          height: 0.03,
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          },
        ),
      } as unknown as ExportsRepository;

      const pdfBaker = new PdfBakerService();
      const exportsService = new ExportsService(
        mockExportsRepo,
        {} as unknown as CitationService,
        pdfBaker,
      );

      const exportedPdf = await exportsService.exportAnnotatedItemPdf(
        USER_A,
        ITEM_1,
        rawPdfBuffer,
        PROJECT_1,
      );

      expect(exportedPdf.filename).toBe(
        'Sparse_Attention_Mechanisms_annotated.pdf',
      );
      expect(exportedPdf.mimeType).toBe('application/pdf');
      expect(exportedPdf.buffer.byteLength).toBeGreaterThan(
        rawPdfBuffer.byteLength,
      );
    });
  });
});
