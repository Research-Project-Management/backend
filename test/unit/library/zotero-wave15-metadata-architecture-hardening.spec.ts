import {
  buildCommandCreateInput,
  buildCommandUpdateInput,
  ConditionEvaluatorEngine,
  buildTypeConversionUpdatePayload,
  ItemTransformer,
  TypesService,
  CatalogFacade,
  ItemCurationService,
  QueryRepository,
  CommandRepository,
} from '@/modules/library/catalog';
import { buildItemSearchCondition } from '@/modules/library/catalog/repositories/item-filter-where.builder';
import { ExtractionMetadataSynchronizer } from '@/modules/library/extraction/services/extraction-metadata.synchronizer';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { LibraryFacade } from '@/modules/library/library.facade';
import { MetadataCoalescePolicy as ReconciliationPolicy } from '@/modules/library/core';
import {
  buildEnrichmentPatch,
  buildReResolvePatch,
} from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import { MetadataResolverService } from '@/modules/library/ingestion/services/metadata-resolver.service';
import {
  FullTextProvider,
  isSafeSearchRegex,
  parseSafeSearchRegex,
} from '@/modules/library/search/services/search.service';
import { TextSearchSpecification } from '@/modules/library/search/domain/item-specifications';
import { buildSearchFtsSqlQuery } from '@/modules/library/search/repositories/search-sql.helper';
import { backfillMetadataAndCreatorsStep } from '@/modules/library/ingestion/repositories/duplicate-merge.repository';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslStyleFormatterService } from '@/modules/library/citation/services/csl-style-formatter.service';
import {
  ItemProvenancePolicy,
  AcademicSearchQueryEngine,
} from '@/modules/library/core';
import {
  createCandidate,
  applyUserOverridesToCandidate,
} from '@/modules/library/ingestion/stages/identify.stage';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { ResolveStage } from '@/modules/library/ingestion/stages/resolve.stage';
import { CommitStage } from '@/modules/library/ingestion/stages/commit.stage';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';

describe('Wave 15 — Unified Metadata Write-Path Gatekeepers & Identifier Search Normalization', () => {
  it('promotes Comment: lines from extra into relational Note rows on create and preserves read-path projection', async () => {
    const { createData } = buildCommandCreateInput(
      'user-123',
      {
        itemType: 'preprint',
        title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs',
        arxivId: '2501.12948',
        extra: 'Comment: 22 pages, 10 figures, accepted to ICML 2025',
      },
    );

    const notesListCreate = (
      createData.notesList as {
        create?: Array<{ contentMd: string; tags: string[] }>;
      }
    )?.create;
    expect(notesListCreate).toBeDefined();
    expect(notesListCreate).toHaveLength(1);
    expect(notesListCreate?.[0]?.contentMd).toBe(
      'Comment: 22 pages, 10 figures, accepted to ICML 2025',
    );
    expect(notesListCreate?.[0]?.tags).toContain('comment');
  });

  it('sanitizes LaTeX/HTML in ExtractionMetadataSynchronizer and disambiguates citationKey in ExtractionRepository', async () => {
    const mockPrisma = {
      item: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'item-ext-1',
          userId: 'user-123',
          projectId: null,
          citationKey: 'anon2025untitled',
          title: 'Untitled Document',
          doi: null,
          abstract: null,
          year: null,
          publicationTitle: null,
          itemType: 'thesis',
          metadata: {},
        }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ citationKey: 'vaswani2025attention' }]),
        update: jest.fn().mockImplementation(async ({ data }) => ({
          id: 'item-ext-1',
          ...data,
        })),
      },
    };
    const repo = new ExtractionRepository(mockPrisma as never);
    const sync = new ExtractionMetadataSynchronizer(repo);

    const plan = sync.buildMetadataSyncPlan(
      {
        id: 'att-1',
        itemId: 'item-ext-1',
        item: {
          id: 'item-ext-1',
          userId: 'user-123',
          title: 'Untitled Document',
          itemType: 'thesis',
          citationKey: 'anon2025untitled',
          metadata: {},
        },
      },
      {
        metadata: {
          title: '<b>Attention</b> in {Quantum} Networks',
          abstract: 'Abstract: This paper studies quantum attention.',
          publisher: 'MIT',
          year: 2025,
          authors: ['Ashish Vaswani'],
        },
      },
    );

    expect(plan.itemPatch.title).toBe('Attention in Quantum Networks');
    expect(plan.metaPatch.abstractNote).toBe(
      'This paper studies quantum attention.',
    );
    expect(plan.metaPatch.university).toBe('MIT');
    expect(plan.itemPatch.citationKey).toBe('vaswani2025attention');

    await repo.updateItemWithExtractedMetadata('item-ext-1', plan.itemPatch);
    expect(mockPrisma.item.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          citationKey: 'vaswani2025attentiona',
          metadata: expect.objectContaining({
            citationKey: 'vaswani2025attentiona',
            university: 'MIT',
          }),
        }),
      }),
    );
  });

  it('harmonizes Zotero aliases and strips transient keys in LibraryFacade.updateItemAiMetadata', async () => {
    const mockPrisma = {
      item: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'item-ai-1',
          userId: 'user-123',
          projectId: null,
          itemType: 'conferencePaper',
          metadata: { existingKey: 'preserved' },
        }),
        update: jest.fn().mockResolvedValue({
          id: 'item-ai-1',
          version: 2,
        }),
      },
    };

    const curationService = new ItemCurationService(
      new QueryRepository(mockPrisma as never),
      new CommandRepository(mockPrisma as never),
      undefined as never,
    );
    const catalogFacade = new CatalogFacade(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      curationService,
    );
    const facade = new LibraryFacade(
      catalogFacade,
      {} as never,
      {} as never,
      {} as never,
    );

    await facade.updateItemAiMetadata('item-ai-1', {
      DOI: '10.1145/1234567',
      ISBN: '978-1-4503-9999-9',
      proceedingsTitle: 'Proceedings of SIGCOMM 2025',
      citationKey: 'shouldBeIgnored',
      aiSummary: 'Concise AI summary',
    });

    expect(mockPrisma.item.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-ai-1' },
        data: {
          metadata: {
            existingKey: 'preserved',
            doi: '10.1145/1234567',
            isbn: '978-1-4503-9999-9',
            proceedingsTitle: 'Proceedings of SIGCOMM 2025',
            publicationTitle: 'Proceedings of SIGCOMM 2025',
            aiSummary: 'Concise AI summary',
            fieldProvenance: {
              doi: {
                source: 'AIMetadata',
                sourceProvider: 'AIMetadata',
                confidence: 0.7,
                verified: false,
              },
              isbn: {
                source: 'AIMetadata',
                sourceProvider: 'AIMetadata',
                confidence: 0.7,
                verified: false,
              },
              proceedingsTitle: {
                source: 'AIMetadata',
                sourceProvider: 'AIMetadata',
                confidence: 0.7,
                verified: false,
              },
              publicationTitle: {
                source: 'AIMetadata',
                sourceProvider: 'AIMetadata',
                confidence: 0.7,
                verified: false,
              },
            },
          },
          doi: '10.1145/1234567',
          publicationTitle: 'Proceedings of SIGCOMM 2025',
          version: { increment: 1 },
        },
      }),
    );
  });

  it('normalizes hyphenated ISBN and prefixed arXiv/PMID/PMCID in buildItemSearchCondition and ConditionEvaluatorEngine', () => {
    const searchClauses = buildItemSearchCondition(
      '978-0-262-03384-8',
      'fields_tags',
    );
    expect(searchClauses).toContainEqual({
      metadata: {
        path: ['isbn'],
        string_contains: '9780262033848',
      },
    });

    const evaluator = new ConditionEvaluatorEngine();
    const compiledIsbn = evaluator.compile('user-123', {
      conjunction: 'AND',
      conditions: [
        { field: 'isbn', operator: 'is', value: '978-0-262-03384-8' },
        { field: 'arxiv', operator: 'contains', value: 'arXiv:2301.00001v2' },
      ],
    }) as { AND: Array<{ AND?: unknown[] }> };

    expect(compiledIsbn.AND[1]).toEqual({
      AND: [
        {
          OR: [
            {
              metadata: {
                path: ['isbn'],
                equals: '9780262033848',
              },
            },
            {
              identifiers: {
                some: {
                  type: 'isbn',
                  value: {
                    equals: '9780262033848',
                    mode: 'insensitive',
                  },
                },
              },
            },
          ],
        },
        {
          OR: [
            {
              metadata: {
                path: ['arxivId'],
                string_contains: '2301.00001v2',
              },
            },
            {
              identifiers: {
                some: {
                  type: 'arxiv',
                  value: {
                    contains: '2301.00001v2',
                    mode: 'insensitive',
                  },
                },
              },
            },
          ],
        },
      ],
    });
  });

  describe('4-Pillar Metadata Pipeline & Extraction-to-Ingestion Redesign', () => {
    it('Pillar 1: MetadataResolverService.reconcileExtractedCandidate enriches OCR-discovered DOI while blocking Page-1 Citation Trap DOIs', async () => {
      const mockCatalog = {
        getItem: jest.fn().mockResolvedValue({
          id: 'item-ocr-1',
          userId: 'user-123',
          version: 1,
          title: 'Novel Graph Neural Network Architecture for Molecular Dynamics',
          itemType: 'journalArticle',
          extraFields: {},
          metadata: {},
        }),
        updateItem: jest.fn().mockResolvedValue({ id: 'item-ocr-1', version: 2 }),
      };

      const mockMetadataPort = {
        resolve: jest
          .fn()
          // 1st call: Cited paper trap (title completely different from PDF title)
          .mockResolvedValueOnce({
            query: '10.1038/nature14539',
            queryType: 'DOI',
            canonicalId: 'doi:10.1038/nature14539',
            metadata: {
              title: 'Deep Learning',
              doi: '10.1038/nature14539',
              journal: 'Nature',
              year: 2015,
            },
          })
          // 2nd call: Authentic paper match
          .mockResolvedValueOnce({
            query: '10.1038/s41586-025-09999-1',
            queryType: 'DOI',
            canonicalId: 'doi:10.1038/s41586-025-09999-1',
            metadata: {
              title: 'Novel Graph Neural Network Architecture for Molecular Dynamics',
              doi: '10.1038/s41586-025-09999-1',
              journal: 'Nature Machine Intelligence',
              volume: '7',
              issue: '3',
              pages: '112-128',
              year: 2025,
            },
          }),
      };

      const resolver = new MetadataResolverService(
        mockCatalog as never,
        mockMetadataPort as never,
      );

      // Case A: Cited paper DOI on page 1 -> blocked by Citation Disambiguation Guard
      const trapRes = await resolver.reconcileExtractedCandidate({
        userId: 'user-123',
        itemId: 'item-ocr-1',
        attachmentId: 'att-ocr-1',
        extractedMetadata: {
          title: 'Novel Graph Neural Network Architecture for Molecular Dynamics',
          doi: '10.1038/nature14539',
        },
        isOcrDerived: true,
      });
      expect(trapRes.updated).toBe(false);
      expect(trapRes.rejectedCitedDoi).toBe('10.1038/nature14539');
      expect(mockCatalog.updateItem).not.toHaveBeenCalled();

      // Case B: Authentic DOI -> enriched & persisted with __isSystemUpdate: true
      const validRes = await resolver.reconcileExtractedCandidate({
        userId: 'user-123',
        itemId: 'item-ocr-1',
        attachmentId: 'att-ocr-1',
        extractedMetadata: {
          title: 'Novel Graph Neural Network Architecture for Molecular Dynamics',
          doi: '10.1038/s41586-025-09999-1',
        },
        isOcrDerived: true,
      });
      expect(validRes.updated).toBe(true);
      expect(validRes.updatedFields).toEqual(
        expect.arrayContaining(['doi', 'publicationTitle', 'volume', 'issue', 'pages']),
      );
      expect(mockCatalog.updateItem).toHaveBeenCalledWith(
        'user-123',
        'item-ocr-1',
        expect.objectContaining({
          doi: '10.1038/s41586-025-09999-1',
          publicationTitle: 'Nature Machine Intelligence',
          __isSystemUpdate: true,
        }),
        expect.objectContaining({ expectedVersion: 1 }),
      );
    });

    it('Pillar 2 & 3: ReconciliationPolicy records per-field winner provenance and buildEnrichmentPatch upgrades low-authority fields', () => {
      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([
        {
          candidateId: 'cand-pdf',
          sourceKind: 'FILE',
          sourceName: 'StagedPdf',
          confidenceScore: 0.5,
          retrievedAt: new Date().toISOString(),
          rawMetadata: {},
          normalizedMetadata: {
            title: '2501.12948v1.pdf',
            year: 2024,
          },
          fields: {
            title: {
              path: 'title',
              value: '2501.12948v1.pdf',
              normalizedValue: '2501.12948v1.pdf',
              confidence: 0.4,
              sourceProvider: 'StagedPdf',
            },
            year: {
              path: 'year',
              value: 2024,
              normalizedValue: 2024,
              confidence: 0.5,
              sourceProvider: 'StagedPdf',
            },
          },
        },
        {
          candidateId: 'cand-crossref',
          sourceKind: 'PROVIDER',
          sourceName: 'CrossRef',
          confidenceScore: 0.98,
          retrievedAt: new Date().toISOString(),
          rawMetadata: {},
          normalizedMetadata: {
            title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
            doi: '10.1038/deepseek-r1',
            year: 2025,
            journal: 'Nature',
          },
          fields: {
            title: {
              path: 'title',
              value: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
              normalizedValue: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
              confidence: 0.98,
              sourceProvider: 'CrossRef',
            },
            doi: {
              path: 'doi',
              value: '10.1038/deepseek-r1',
              normalizedValue: '10.1038/deepseek-r1',
              confidence: 0.99,
              sourceProvider: 'CrossRef',
            },
            year: {
              path: 'year',
              value: 2025,
              normalizedValue: 2025,
              confidence: 0.98,
              sourceProvider: 'CrossRef',
            },
            journal: {
              path: 'journal',
              value: 'Nature',
              normalizedValue: 'Nature',
              confidence: 0.98,
              sourceProvider: 'CrossRef',
            },
          },
        },
      ]);

      const fieldProv = (
        decision.proposedItem.extraFields as {
          fieldProvenance?: Record<string, { sourceProvider: string; confidence: number }>;
        }
      )?.fieldProvenance;
      expect(fieldProv?.title?.sourceProvider).toBe('CrossRef');
      expect(fieldProv?.doi?.sourceProvider).toBe('CrossRef');
      expect(fieldProv?.publicationTitle?.sourceProvider).toBe('CrossRef');

      // Existing item in DB has low-authority StagedPdf metadata (e.g. wrong year=2024 and noisy title)
      const existingStagedItem = {
        id: 'item-staged-1',
        itemType: 'journalArticle',
        title: 'Rough OCR Header Text',
        year: 2024,
        publicationTitle: 'Preprint Draft',
        metadata: {
          engineUsed: 'StagedPdf',
          fieldProvenance: {
            title: { source: 'StagedPdf', confidence: 0.4 },
            year: { source: 'StagedPdf', confidence: 0.4 },
            publicationTitle: { source: 'StagedPdf', confidence: 0.4 },
          },
        },
      };

      const patch = buildEnrichmentPatch(
        existingStagedItem,
        decision.proposedItem as Record<string, unknown>,
      );

      expect(patch.title).toBe(
        'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
      );
      expect(patch.year).toBe(2025);
      expect(patch.publicationTitle).toBe('Nature');
      expect(patch.__isSystemUpdate).toBe(true);
    });

    it('Pillar 4: Manual user edit locks modified fields (UserOverride = 1.0) and prevents overwrite by Enrichment, ReResolve, and Extraction', async () => {
      const existingItem = {
        id: 'item-lock-1',
        userId: 'user-123',
        projectId: null,
        itemType: 'journalArticle',
        title: 'Original System Title',
        doi: '10.1000/orig',
        year: 2024,
        abstract: 'Original abstract',
        publicationTitle: 'Original Journal',
        citationKey: 'smith2024original',
        metadata: {
          title: 'Original System Title',
          year: 2024,
          publicationTitle: 'Original Journal',
          fieldProvenance: {
            title: { source: 'CrossRef', confidence: 0.95 },
          },
        },
      };

      // 1. User manually edits `title` and `publicationTitle` via Catalog update
      const { updateData } = await buildCommandUpdateInput(
        'user-123',
        existingItem as never,
        {
          title: 'My Custom Curated Title',
          publicationTitle: 'Curated Venue Name',
        },
      );

      const updatedMeta = updateData.metadata as Record<string, unknown>;
      const lockedFields = updatedMeta.lockedFields as string[];
      const fieldProvenance = updatedMeta.fieldProvenance as Record<
        string,
        { source: string; confidence: number; isUserOverride: boolean }
      >;

      expect(lockedFields).toEqual(
        expect.arrayContaining(['title', 'publicationTitle']),
      );
      expect(fieldProvenance.title).toEqual(
        expect.objectContaining({
          source: 'UserOverride',
          confidence: 1.0,
          isUserOverride: true,
        }),
      );

      const itemAfterUserEdit = {
        ...existingItem,
        title: 'My Custom Curated Title',
        publicationTitle: 'Curated Venue Name',
        metadata: updatedMeta,
        extraFields: updatedMeta,
      };

      // 2. Subsequent buildEnrichmentPatch with CrossRef (0.98) must NOT overwrite locked title/publicationTitle, but CAN fill unlocked volume
      const enrichPatch = buildEnrichmentPatch(itemAfterUserEdit, {
        itemType: 'journalArticle',
        title: 'CrossRef Registry Title',
        publicationTitle: 'CrossRef Journal',
        volume: '42',
        sourceProvider: 'CrossRef',
      });
      expect(enrichPatch.title).toBeUndefined();
      expect(enrichPatch.publicationTitle).toBeUndefined();
      expect(enrichPatch.volume).toBe('42');

      // 3. Subsequent buildReResolvePatch must NOT overwrite locked title/publicationTitle, but CAN update unlocked abstract
      const reResolve = buildReResolvePatch(itemAfterUserEdit, {
        itemType: 'journalArticle',
        title: 'CrossRef Registry Title',
        publicationTitle: 'CrossRef Journal',
        abstract: 'Newly resolved authoritative abstract',
      });
      expect(reResolve.updatedFields).not.toContain('title');
      expect(reResolve.updatedFields).not.toContain('publicationTitle');
      expect(reResolve.updatedFields).toContain('abstract');

      // 4. Subsequent ExtractionMetadataSynchronizer must NOT overwrite user-locked fields
      const sync = new ExtractionMetadataSynchronizer({} as never);
      const syncPlan = sync.buildMetadataSyncPlan(
        {
          id: 'att-lock-1',
          itemId: 'item-lock-1',
          item: {
            ...itemAfterUserEdit,
            title: 'Untitled Document', // Even if someone set a placeholder or extraction wants to update
          },
        },
        {
          metadata: {
            title: 'Extracted PDF Header Title',
            publicationTitle: 'Extracted PDF Journal',
            pages: '1-15',
          },
        },
      );
      expect(syncPlan.itemPatch.title).toBeUndefined();
      expect(syncPlan.metaPatch.title).toBeUndefined();
      expect(syncPlan.metaPatch.publicationTitle).toBeUndefined();
      expect(syncPlan.metaPatch.pages).toBe('1-15');
    });
  });

  describe('4-Pillar Cross-Module Library Architecture Upgrade (Search, Catalog, DuplicateMerger & Citation, LibraryFacade)', () => {
    it('Pillar 1 (SearchModule): supports safe regex anchor search with ReDoS protection and identifier/FullTextIndex search', async () => {
      // 1. ReDoS guard & safe regex parsing
      expect(isSafeSearchRegex('(a+)+$')).toBe(false);
      expect(parseSafeSearchRegex('/(a+)+$/i')).toBeNull();
      expect(parseSafeSearchRegex('/fig(?:ure)?\\s+\\d+/i')).toBeInstanceOf(
        RegExp,
      );

      const mockSearchRepo = {
        findAttachmentPages: jest.fn().mockResolvedValue([
          {
            pageIndex: 2,
            textContent:
              'As shown in Figure 14 and Fig 3, the latency drops by 45%.',
            charOffset: 1000,
          },
        ]),
      };
      const fullTextProvider = new FullTextProvider(mockSearchRepo as never);
      const matches = await fullTextProvider.searchPageAnchors(
        'att-regex-1',
        '/fig(?:ure)?\\s+\\d+/i',
      );
      expect(matches).toHaveLength(2);
      expect(matches[0]).toEqual(
        expect.objectContaining({
          attachmentId: 'att-regex-1',
          pageIndex: 2,
          charOffsetStart: 1012,
          charOffsetEnd: 1021,
        }),
      );

      // 2. TextSearchSpecification normalizes ISBN/arXiv and includes fullTextIndex
      const spec = new TextSearchSpecification('978-0-262-03384-8');
      const prismaWhere = spec.toPrismaWhere() as { OR: unknown[] };
      expect(prismaWhere.OR).toContainEqual({
        metadata: { path: ['isbn'], string_contains: '9780262033848' },
      });
      expect(
        spec.isSatisfiedBy({
          title: 'Introduction to Algorithms',
          metadata: { isbn: '9780262033848' },
        }),
      ).toBe(true);
      expect(
        spec.isSatisfiedBy({
          title: 'Paper with PDF fulltext',
          attachments: [
            {
              deletedAt: null,
              fullTextIndex: [{ textContent: 'Contains 978-0-262-03384-8 inside PDF' }],
            },
          ],
        }),
      ).toBe(true);

      // 3. buildSearchFtsSqlQuery includes full_text_indexes and normalized identifier clauses
      const sqlBuilt = buildSearchFtsSqlQuery({
        userId: '550e8400-e29b-41d4-a716-446655440000',
        options: { q: 'arXiv:2301.00001v2' },
        queryText: 'arXiv 2301 00001v2',
        limit: 20,
      });
      expect(sqlBuilt?.sql).toContain('full_text_indexes');
      expect(sqlBuilt?.sql).toContain("metadata->>'arxivId'");
      expect(sqlBuilt?.params).toContain('%2301.00001%');
    });

    it('Pillar 2 (CatalogModule): ItemTypeConversion locks only itemType (__isSystemUpdate = true) and transfers mapped field provenance', () => {
      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);
      const existingItem = {
        id: 'item-conv-1',
        userId: 'user-123',
        itemType: 'conferencePaper',
        title: 'Attention Is All You Need',
        proceedingsTitle: 'Advances in Neural Information Processing Systems',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        year: 2017,
        creators: [{ firstName: 'Ashish', lastName: 'Vaswani', creatorType: 'author' }],
        extraFields: {
          proceedingsTitle: 'Advances in Neural Information Processing Systems',
          fieldProvenance: {
            title: { source: 'CrossRef', confidence: 0.98 },
            proceedingsTitle: { source: 'CrossRef', confidence: 0.98 },
          },
          lockedFields: ['proceedingsTitle'],
        },
        metadata: {
          proceedingsTitle: 'Advances in Neural Information Processing Systems',
          fieldProvenance: {
            title: { source: 'CrossRef', confidence: 0.98 },
            proceedingsTitle: { source: 'CrossRef', confidence: 0.98 },
          },
          lockedFields: ['proceedingsTitle'],
        },
      };

      const preview = transformer.previewConversion(
        existingItem as never,
        'journalArticle',
        { retainUnmappedInExtra: true },
      );
      const conversionPayload = buildTypeConversionUpdatePayload(
        'journalArticle',
        existingItem as never,
        preview,
        [
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'publicationTitle', label: 'Publication', type: 'text' },
          { key: 'year', label: 'Year', type: 'number' },
        ],
        transformer,
      );

      expect(conversionPayload.__isSystemUpdate).toBe(true);

      // Run through buildCommandUpdateInput to verify it does NOT lock title or year as UserOverride
      const { updateData } = buildCommandUpdateInput(
        'user-123',
        existingItem as never,
        conversionPayload as never,
      );
      const updatedMeta = updateData.metadata as Record<string, unknown>;
      const lockedFields = updatedMeta.lockedFields as string[];
      const fieldProvenance = updatedMeta.fieldProvenance as Record<
        string,
        { source: string; confidence: number }
      >;

      expect(lockedFields).toContain('itemType');
      expect(lockedFields).not.toContain('title');
      expect(lockedFields).not.toContain('year');
      expect(fieldProvenance.title?.source).toBe('CrossRef');
      expect(fieldProvenance.itemType?.source).toBe('UserOverride');
    });

    it('Pillar 3 (DuplicateMerger & Citation): promotes user-locked fields from secondary duplicates and exports complete BibTeX identifiers', async () => {
      const primaryMeta: Record<string, unknown> = {
        title: 'Auto-Imported Title',
        fieldProvenance: {
          title: { source: 'StagedPdf', confidence: 0.4 },
        },
      };
      const backfillFields: Record<string, unknown> = {};

      await backfillMetadataAndCreatorsStep({
        tx: {
          contributor: { count: jest.fn().mockResolvedValue(1) },
        } as never,
        primary: {
          id: 'prim-1',
          title: 'Auto-Imported Title',
          abstract: 'Auto abstract',
          metadata: primaryMeta,
        },
        duplicates: [
          {
            id: 'dup-1',
            title: 'User Curated Masterpiece Title',
            abstract: 'Duplicate abstract',
            metadata: {
              isbn: '9780262033848',
              arxivId: '2301.00001',
              lockedFields: ['title'],
              fieldProvenance: {
                title: {
                  source: 'UserOverride',
                  confidence: 1.0,
                  isUserOverride: true,
                },
                isbn: {
                  source: 'CrossRef',
                  confidence: 0.95,
                },
              },
            },
          },
        ],
        uniqueDupIds: ['dup-1'],
        rawSelections: {},
        scalarSelections: {},
        primaryMeta,
        backfillFields,
        offloadedFileIdsToDelete: [],
        now: new Date(),
      });

      // Secondary item's user-locked title is promoted over primary's unlocked title!
      expect(backfillFields.title).toBe('User Curated Masterpiece Title');
      expect(primaryMeta.lockedFields).toContain('title');
      expect(
        (primaryMeta.fieldProvenance as Record<string, { source: string }>)
          .title.source,
      ).toBe('UserOverride');
      expect(
        (primaryMeta.fieldProvenance as Record<string, { source: string }>)
          .isbn.source,
      ).toBe('CrossRef');

      // BibTeX export includes eprint, archiveprefix, primaryclass, pmid, isbn, doi
      const csl = CslJsonMapper.toCsl({
        id: 'item-bib-1',
        citationKey: 'vaswani2017attention',
        itemType: 'preprint',
        title: 'Attention Is All You Need',
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
        arxivId: '1706.03762',
        pmid: '12345678',
        isbn: '9780262033848',
        extraFields: { primaryClass: 'cs.CL' },
      });
      const formatter = new CslStyleFormatterService();
      const bibtex = formatter.formatBibtex(csl);
      expect(bibtex).toContain('eprint = {1706.03762}');
      expect(bibtex).toContain('archiveprefix = {arXiv}');
      expect(bibtex).toContain('primaryclass = {cs.CL}');
      expect(bibtex).toContain('pmid = {12345678}');
      expect(bibtex).toContain('isbn = {9780262033848}');
    });

    it('Pillar 4 (LibraryFacade): updateItemAiMetadata protects user-locked and high-authority fields while allowing AI summary fields', async () => {
      const mockPrisma = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'item-ai-locked',
            userId: 'user-123',
            projectId: null,
            itemType: 'journalArticle',
            metadata: {
              title: 'Curated Title',
              publicationTitle: 'Nature',
              lockedFields: ['title'],
              fieldProvenance: {
                title: {
                  source: 'UserOverride',
                  confidence: 1.0,
                  isUserOverride: true,
                },
                publicationTitle: {
                  source: 'CrossRef',
                  confidence: 0.98,
                },
              },
            },
          }),
          update: jest.fn().mockResolvedValue({
            id: 'item-ai-locked',
            version: 2,
          }),
        },
      };

      const curationService = new ItemCurationService(
        new QueryRepository(mockPrisma as never),
        new CommandRepository(mockPrisma as never),
        undefined as never,
      );
      const catalogFacade = new CatalogFacade(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        curationService,
      );
      const facade = new LibraryFacade(
        catalogFacade,
        {} as never,
        {} as never,
        {} as never,
      );

      await facade.updateItemAiMetadata('item-ai-locked', {
        title: 'Hallucinated AI Title',
        journal: 'Hallucinated AI Venue',
        abstract: 'Newly generated AI abstract for empty slot',
        aiSummary: 'Key takeaway summary',
      });

      const updateCall = mockPrisma.item.update.mock.calls[0][0];
      const savedMeta = updateCall.data.metadata as Record<string, unknown>;
      expect(savedMeta.title).toBe('Curated Title');
      expect(savedMeta.publicationTitle).toBe('Nature');
      expect(savedMeta.abstract).toBe(
        'Newly generated AI abstract for empty slot',
      );
      expect(savedMeta.aiSummary).toBe('Key takeaway summary');
    });
  });

  describe('Matt Pocock Deep Modules — ItemProvenancePolicy & AcademicSearchQueryEngine', () => {
    it('ItemProvenancePolicy provides a single authoritative interface for provenance state, authority calculation, and overwrite rules', () => {
      const sampleItem = {
        id: 'item-deep-1',
        metadata: {
          isFilenameTitle: false,
          lockedFields: ['publisher'],
          fieldProvenance: {
            title: {
              sourceProvider: 'Crossref',
              confidence: 0.98,
            },
            abstract: {
              sourceProvider: 'BibTeX',
              confidence: 0.65,
            },
            year: {
              source: 'UserOverride',
              isUserOverride: true,
              confidence: 1.0,
            },
          },
        },
      };

      const state = ItemProvenancePolicy.extractProvenanceState(sampleItem);
      expect(state.lockedSet.has('publisher')).toBe(true);
      expect(state.lockedSet.has('year')).toBe(true);
      expect(ItemProvenancePolicy.isFieldLocked(sampleItem, 'year')).toBe(true);
      expect(ItemProvenancePolicy.getFieldAuthority(sampleItem, 'year')).toBe(
        1.0,
      );

      // Crossref title has high authority (~0.95) -> cannot be overwritten by BibTeX (0.65)
      expect(
        ItemProvenancePolicy.canOverwriteField(sampleItem, 'title', 'BibTeX'),
      ).toBe(false);

      // BibTeX abstract has low authority (~0.5395) -> can be overwritten by PubMed (0.98 * 0.95)
      expect(
        ItemProvenancePolicy.canOverwriteField(sampleItem, 'abstract', 'PubMed', {
          incomingConfidence: 0.95,
          minAdvantage: 0.08,
        }),
      ).toBe(true);
    });

    it('AcademicSearchQueryEngine unifies identifier extraction, field target normalization, and in-memory matching across Search & Catalog', () => {
      const ids = AcademicSearchQueryEngine.extractIdentifiers(
        'https://doi.org/10.1038/Nature14539 ISBN 978-0-262-03384-8 arXiv:2501.12948v2',
      );
      expect(ids.cleanDoi).toBe('10.1038/nature14539');
      expect(ids.cleanIsbn).toBe('9780262033848');
      expect(ids.cleanArxivBase).toBe('2501.12948');

      expect(
        AcademicSearchQueryEngine.normalizeFieldTargetValue(
          'arxivId',
          'arXiv:2501.12948v3',
        ),
      ).toBe('2501.12948v3');
      expect(
        AcademicSearchQueryEngine.normalizeFieldTargetValue(
          'isbn',
          '978-0-262-03384-8',
        ),
      ).toBe('9780262033848');

      const mockBook = {
        title: 'Introduction to Algorithms',
        metadata: { isbn: '9780262033848' },
      };
      expect(
        AcademicSearchQueryEngine.matchesItemIdentifiersInMemory(mockBook, {
          cleanIsbn: '9780262033848',
        }),
      ).toBe(true);
    });
  });

  describe('Ingestion Pipeline Metadata Cases — User Overrides, Alias Provenance, Batch Deduplication & Pre-Match Enrichment', () => {
    it('Case 1: applyUserOverridesToCandidate & ReconciliationPolicy preserve envelope.overrides over CrossRef (EnrichedProvider) and lock overridden fields', () => {
      const normalizer = new NormalizationPolicy();
      const baseCandidate = createCandidate({
        sourceKind: 'IDENTIFIER',
        sourceName: 'DirectIdentifier',
        sourceRecordId: '10.1038/nature14539',
        rawMetadata: { doi: '10.1038/nature14539' },
        confidenceScore: 1.0,
        normalizer,
      });

      const overriddenCandidate = applyUserOverridesToCandidate(
        baseCandidate,
        {
          title: 'My Curated Seminar Title',
          year: 2026,
          authors: ['Ada Lovelace'],
        },
        normalizer,
      );

      const enrichedProviderCandidate = {
        candidateId: 'enriched-1',
        sourceKind: 'PROVIDER' as const,
        sourceName: 'EnrichedProvider',
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        confidenceScore: 0.95,
        normalizedMetadata: {
          title: 'Deep learning',
          year: 2015,
          authors: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'],
          publicationTitle: 'Nature',
        },
        fields: {
          title: {
            path: 'title',
            value: 'Deep learning',
            normalizedValue: 'Deep learning',
            confidence: 0.98,
            sourceProvider: 'CrossRef',
            retrievedAt: new Date().toISOString(),
          },
          year: {
            path: 'year',
            value: 2015,
            normalizedValue: 2015,
            confidence: 0.98,
            sourceProvider: 'CrossRef',
            retrievedAt: new Date().toISOString(),
          },
          authors: {
            path: 'authors',
            value: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'],
            normalizedValue: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'],
            confidence: 0.98,
            sourceProvider: 'CrossRef',
            retrievedAt: new Date().toISOString(),
          },
          publicationTitle: {
            path: 'publicationTitle',
            value: 'Nature',
            normalizedValue: 'Nature',
            confidence: 0.98,
            sourceProvider: 'CrossRef',
            retrievedAt: new Date().toISOString(),
          },
        },
      };

      const reconciler = new ReconciliationPolicy();
      const decision = reconciler.reconcile([
        overriddenCandidate,
        enrichedProviderCandidate,
      ]);

      expect(decision.proposedItem.title).toBe('My Curated Seminar Title');
      expect(decision.proposedItem.year).toBe(2026);
      expect(decision.proposedItem.authors).toEqual(['Ada Lovelace']);
      // Non-overridden field from CrossRef is still enriched
      expect(decision.proposedItem.publicationTitle).toBe('Nature');

      const extra = decision.proposedItem.extraFields as Record<string, unknown>;
      const lockedFields = extra.lockedFields as string[];
      expect(lockedFields).toEqual(
        expect.arrayContaining(['title', 'year', 'authors']),
      );
      const prov = extra.fieldProvenance as Record<
        string,
        { sourceProvider: string; isUserOverride?: boolean }
      >;
      expect(prov.title.sourceProvider).toBe('UserOverride');
      expect(prov.title.isUserOverride).toBe(true);
    });

    it('Case 2: EnrichStage preserves winning provider provenance on harmonized aliases and links all batch candidates sharing a query', async () => {
      const normalizer = new NormalizationPolicy();
      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          canonicalId: '10.1038/nature14539',
          queryType: 'DOI',
          resolvedAt: '2026-10-27T00:00:00.000Z',
          metadata: {
            doi: '10.1038/nature14539',
            title: 'Deep learning',
            journal: 'Nature',
            creators: [
              {
                firstName: 'Yann',
                lastName: 'LeCun',
                creatorType: 'author',
              },
            ],
          },
          provenance: {
            title: {
              provider: 'CrossRef',
              confidence: 0.98,
              fetchedAt: '2026-10-27T00:00:00.000Z',
            },
            journal: {
              provider: 'CrossRef',
              confidence: 0.98,
              fetchedAt: '2026-10-27T00:00:00.000Z',
            },
            creators: {
              provider: 'CrossRef',
              confidence: 0.98,
              fetchedAt: '2026-10-27T00:00:00.000Z',
            },
          },
        }),
      };

      const enrichStage = new ResolveStage(
        mockMetadataService as never,
        normalizer,
      );

      const cand1 = createCandidate({
        sourceKind: 'RECORD',
        sourceName: 'BibTeX',
        rawMetadata: { doi: '10.1038/nature14539', title: 'Draft 1' },
        confidenceScore: 0.75,
        normalizer,
      });
      const cand2 = createCandidate({
        sourceKind: 'RECORD',
        sourceName: 'BibTeX',
        rawMetadata: { doi: '10.1038/nature14539', title: 'Draft 2' },
        confidenceScore: 0.75,
        normalizer,
      });

      const results = await enrichStage.execute({
        scopeId: 'user-1',
        candidates: [cand1, cand2],
      });

      // Only 1 network call for the shared DOI
      expect(mockMetadataService.resolve).toHaveBeenCalledTimes(1);

      const providerCandidates = results.filter(
        (c) => c.sourceKind === 'PROVIDER',
      );
      // Both batch candidates receive their own linked EnrichedProvider candidate
      expect(providerCandidates).toHaveLength(2);
      expect(providerCandidates.map((c) => c.rawEvidenceRef)).toEqual([
        cand1.candidateId,
        cand2.candidateId,
      ]);

      // Harmonized alias fields (publicationTitle from journal, authors from creators) retain CrossRef (0.98)
      expect(providerCandidates[0].fields.publicationTitle.sourceProvider).toBe(
        'CrossRef',
      );
      expect(providerCandidates[0].fields.publicationTitle.confidence).toBe(
        0.98,
      );
      expect(providerCandidates[0].fields.authors.sourceProvider).toBe(
        'CrossRef',
      );
    });

    it('Case 3: UrlCaptureService.confirmCapturedUrl records user-edited DTO fields in lockedFields and additively enriches existing duplicates', async () => {
      const mockRepo = {
        findCapturePreviewByTokenHash: jest.fn().mockResolvedValue({
          userId: 'user-1',
          sourceUrl: 'https://example.org/paper',
          claimedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          canonicalMetadata: {
            title: 'Scraped Title',
            year: 2023,
            doi: '10.1000/url-cap-1',
            abstract: 'Newly scraped abstract from publisher page',
          },
        }),
        claimCapturePreview: jest.fn().mockResolvedValue(1),
        releaseCapturePreview: jest.fn().mockResolvedValue(undefined),
      };

      const mockCatalogGateway = {
        createItem: jest.fn().mockImplementation((_u, data) =>
          Promise.resolve({ id: 'new-item-1', ...data }),
        ),
        getItem: jest.fn().mockResolvedValue({
          id: 'existing-dup-1',
          title: 'Scraped Title',
          doi: '10.1000/url-cap-1',
          abstract: null,
          metadata: {},
        }),
        updateItem: jest.fn().mockResolvedValue({ id: 'existing-dup-1' }),
      };

      const service = new UrlCaptureService(
        mockRepo as never,
        undefined,
        undefined,
        mockCatalogGateway as never,
      );

      const created = await service.confirmCapturedUrl('user-1', 'user-1', {
        previewToken: 'tok-123',
        title: 'User Refined Title',
        year: 2025,
      });

      const passedItemData = mockCatalogGateway.createItem.mock.calls[0][1];
      expect(passedItemData.title).toBe('User Refined Title');
      expect(passedItemData.extraFields.lockedFields).toEqual(
        expect.arrayContaining(['title', 'year']),
      );
      expect(created.id).toBe('new-item-1');
    });

    it('Case 4: CommitStage applies buildEnrichmentPatch when pre-match finds an existing item instead of discarding new metadata', async () => {
      const mockCatalogGateway = {
        getPrimaryCreatorType: jest.fn().mockReturnValue('author'),
        findMatchCandidates: jest.fn().mockResolvedValue({
          exactMatch: { id: 'existing-prematch-1' },
        }),
        getItem: jest.fn().mockResolvedValue({
          id: 'existing-prematch-1',
          title: 'Existing Paper',
          doi: '10.1038/nature14539',
          abstract: null,
          metadata: {},
        }),
        updateItem: jest.fn().mockResolvedValue({
          id: 'existing-prematch-1',
          title: 'Existing Paper',
          doi: '10.1038/nature14539',
          abstract: 'Backfilled abstract on pre-match',
        }),
        createItem: jest.fn(),
      };

      const commitStage = new CommitStage(mockCatalogGateway as never);
      const result = await commitStage.execute({
        scopeId: 'user-1',
        item: {
          title: 'Existing Paper',
          doi: '10.1038/nature14539',
          abstract: 'Backfilled abstract on pre-match',
        },
        options: { userId: 'user-1' },
      });

      expect(mockCatalogGateway.updateItem).toHaveBeenCalledTimes(1);
      expect(mockCatalogGateway.updateItem).toHaveBeenCalledWith(
        'user-1',
        'existing-prematch-1',
        expect.objectContaining({
          abstract: 'Backfilled abstract on pre-match',
        }),
        expect.anything(),
      );
      expect(result.abstract).toBe('Backfilled abstract on pre-match');
      expect(
        (result as unknown as { __wasPreExistingMatch?: boolean })
          .__wasPreExistingMatch,
      ).toBe(true);
    });

    it('Case 5 (Adversarial Hardening): Coupled alias locks (journal <-> publicationTitle, authors <-> creators) and nested-group ReDoS guards hold under stress', () => {
      // 1. Coupled alias lock: locking 'journal' blocks 'publicationTitle' in buildReResolvePatch and buildEnrichmentPatch
      const existingWithJournalLock = {
        id: 'item-alias-lock-1',
        title: 'Paper Title',
        publicationTitle: 'My Curated Journal',
        authors: ['Curated Author'],
        metadata: {
          lockedFields: ['journal', 'authors'],
          fieldProvenance: {
            journal: {
              source: 'UserOverride',
              isUserOverride: true,
              confidence: 1.0,
            },
          },
        },
      };

      const reResolved = buildReResolvePatch(existingWithJournalLock, {
        title: 'Updated Title',
        publicationTitle: 'Provider Venue Should Be Blocked',
        creators: [{ firstName: 'Provider', lastName: 'Creator' }],
        abstract: 'New Provider Abstract',
      });
      expect(reResolved.updateData.publicationTitle).toBeUndefined();
      expect(reResolved.updateData.creators).toBeUndefined();
      expect(reResolved.updateData.abstract).toBe('New Provider Abstract');

      const enrichPatch = buildEnrichmentPatch(existingWithJournalLock, {
        publicationTitle: 'Provider Venue Should Be Blocked',
        creators: [{ firstName: 'Provider', lastName: 'Creator' }],
        abstract: 'New Provider Abstract',
      });
      expect(enrichPatch.publicationTitle).toBeUndefined();
      expect(enrichPatch.creators).toBeUndefined();
      expect(enrichPatch.abstract).toBe('New Provider Abstract');

      // 2. Nested-group ReDoS protection in AcademicSearchQueryEngine.isSafeRegex
      expect(AcademicSearchQueryEngine.isSafeRegex('((a+))+')).toBe(false);
      expect(AcademicSearchQueryEngine.isSafeRegex('(?:(a+))+')).toBe(false);
      expect(AcademicSearchQueryEngine.isSafeRegex('(aa|a)+')).toBe(false);
      expect(
        AcademicSearchQueryEngine.isSafeRegex('transformer\\s+v[23]'),
      ).toBe(true);

      // 3. Hyphenated ISBN and exact PMID matching in memory
      expect(
        AcademicSearchQueryEngine.matchesItemIdentifiersInMemory(
          {
            title: 'Book with hyphenated ISBN-10 and lowercase x',
            metadata: { isbn: '0-306-40615-x', pmid: '91234568' },
          },
          { cleanIsbn: '030640615X' },
        ),
      ).toBe(true);
      expect(
        AcademicSearchQueryEngine.matchesItemIdentifiersInMemory(
          {
            title: 'Paper with longer PMID',
            metadata: { pmid: '91234568' },
          },
          { cleanPmid: '123456' },
        ),
      ).toBe(false);
    });
  });
});
