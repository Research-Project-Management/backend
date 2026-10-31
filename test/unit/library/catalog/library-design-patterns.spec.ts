import {
  EXACT_MATCH_SPECIFICATIONS,
  DoiExactMatchSpecification,
  ArxivExactMatchSpecification,
  PmidExactMatchSpecification,
  IsbnExactMatchSpecification,
  normalizeExactMatchCandidateInput,
  buildExactMatchOrClauses,
  evaluateExactMatchSpecifications,
} from '@/modules/library/catalog/domain/match-specifications.domain';
import { ItemMatchQueryRepository } from '@/modules/library/catalog/repositories/item-match-query.repository';
import { BibliographyFormatRegistry } from '@/modules/library/ingestion/parsers/bibliography-format.registry';
import {
  EXPORT_FORMAT_STRATEGIES,
  resolveExportFormatStrategy,
  BibtexExportStrategy,
  RisExportStrategy,
  CslJsonExportStrategy,
  CsvExportStrategy,
  MarkdownExportStrategy,
} from '@/modules/library/citation/domain/export-format.strategies';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import {
  DEFAULT_DUPLICATE_MERGE_STEPS,
  applyRetractionSurvivalStep,
  backfillMetadataAndCreatorsStep,
  consolidateItemMetadataStep,
  buildMergeAuditTrail,
  executeDuplicateMergePipeline,
} from '@/modules/library/ingestion/repositories/duplicate-merge.repository';
import {
  TYPE_CONVERSION_RULES,
  applyStructuralTypeConversionRules,
  BookToBookSectionConversionRule,
  BookSectionToBookConversionRule,
  ToConferencePaperConversionRule,
  ToJournalArticleConversionRule,
} from '@/modules/library/catalog/domain/type-conversion-rules.domain';
import { ItemTransformer } from '@/modules/library/catalog/services/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import {
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  QueryCriteria,
} from '@/modules/library/core/domain/specification.domain';
import {
  ActiveItemsSpecification,
  YearRangeSpecification,
  ScopeSpecification,
} from '@/modules/library/search/domain/item-specifications';
import {
  AbstractAcademicProvider,
  buildAcademicProviderResult,
  rankBestTitleCandidate,
} from '@/modules/library/ingestion/providers/abstract-academic.provider';
import {
  PdfExtractionTierContext,
  runPdfExtractionTierChain,
  IPdfExtractionTier,
} from '@/modules/library/extraction/domain/attachments.domain';
import { DblpProvider } from '@/modules/library/ingestion/providers/dblp.provider';
import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';
import { OpenAlexProvider } from '@/modules/library/ingestion/providers/openalex.provider';
import { PubMedProvider } from '@/modules/library/ingestion/providers/pubmed.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import {
  buildItemWhereClause,
  ItemWhereSpecification,
} from '@/modules/library/catalog/repositories/item-filter-where.builder';
import { ItemListQueryRepository } from '@/modules/library/catalog/repositories/item-list-query.repository';
import {
  BIBLIOGRAPHIC_QUALITY_RULES,
  calculateMetadataQualityScore,
  diagnoseBibliographicQualityIssues,
} from '@/modules/library/ingestion/domain/metadata.validator';
import { QualityService } from '@/modules/library/ingestion/services/retraction.service';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { resolveExtraPlainText } from '@/modules/library/catalog/domain/creator-tag-payload.builder';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';
import { syncMergedIdentifiersInTx } from '@/modules/library/ingestion/repositories/duplicate-merge.repository';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { MetadataCoalescePolicy as ReconciliationPolicy } from '@/modules/library/core';
import { buildEnrichmentPatch } from '@/modules/library/ingestion/domain/enrichment-patch.builder';

describe('Library Backend Deepened Design Patterns (BE-P1 to BE-P4)', () => {
  describe('BE-P1: Specification Pattern for Identifier & Duplicate Matching', () => {
    it('exports 4 canonical exact match specifications in priority order', () => {
      expect(EXACT_MATCH_SPECIFICATIONS).toHaveLength(4);
      expect(EXACT_MATCH_SPECIFICATIONS[0]).toBeInstanceOf(
        DoiExactMatchSpecification,
      );
      expect(EXACT_MATCH_SPECIFICATIONS[1]).toBeInstanceOf(
        ArxivExactMatchSpecification,
      );
      expect(EXACT_MATCH_SPECIFICATIONS[2]).toBeInstanceOf(
        PmidExactMatchSpecification,
      );
      expect(EXACT_MATCH_SPECIFICATIONS[3]).toBeInstanceOf(
        IsbnExactMatchSpecification,
      );
    });

    it('builds Prisma OR clauses across applicable specifications (including version-stripped arXiv)', () => {
      const input = normalizeExactMatchCandidateInput({
        doi: ' 10.1038/Nature123 ',
        arxivId: '2106.09685v2',
        pmid: '31452104',
        isbn: '978-0-13-235088-4',
      });

      expect(input).toEqual({
        cleanDoi: '10.1038/nature123',
        cleanArxiv: '2106.09685v2',
        cleanPmid: '31452104',
        cleanIsbn: '9780132350884',
      });

      const clauses = buildExactMatchOrClauses(input);
      expect(clauses.length).toBeGreaterThanOrEqual(8);
      expect(clauses).toEqual(
        expect.arrayContaining([
          { doi: { equals: '10.1038/nature123', mode: 'insensitive' } },
          { metadata: { path: ['arxivId'], equals: '2106.09685v2' } },
          { metadata: { path: ['arxivId'], equals: '2106.09685' } },
          { metadata: { path: ['pmid'], equals: '31452104' } },
          { metadata: { path: ['isbn'], equals: '9780132350884' } },
        ]),
      );
    });

    it('evaluates matched candidate rows against metadata and identifiers relations', () => {
      const input = normalizeExactMatchCandidateInput({
        doi: '10.1000/non-matching',
        arxivId: '2303.08774v1',
        pmid: '99999999',
        isbn: null,
      });

      const matchByArxivIdentifier = evaluateExactMatchSpecifications(input, {
        id: 'item-arxiv-1',
        title: 'GPT-4 Technical Report',
        doi: '10.9999/other',
        metadata: {},
        identifiers: [{ type: 'arxiv', value: '2303.08774' }],
      });

      expect(matchByArxivIdentifier).toEqual({
        id: 'item-arxiv-1',
        title: 'GPT-4 Technical Report',
        matchReason: 'ARXIV_EXACT',
        evidence: { arxivId: '2303.08774v1' },
      });

      const matchByPmidMeta = evaluateExactMatchSpecifications(input, {
        id: 'item-pmid-1',
        title: 'PubMed Indexed Study',
        doi: '10.9999/other',
        metadata: { pmid: '99999999' },
        identifiers: [],
      });

      expect(matchByPmidMeta).toEqual({
        id: 'item-pmid-1',
        title: 'PubMed Indexed Study',
        matchReason: 'PMID_EXACT',
        evidence: { pmid: '99999999' },
      });
    });

    it('integrates cleanly with ItemMatchQueryRepository.findMatchCandidates', async () => {
      const mockPrisma = {
        item: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'matched-id-1',
            title: 'Matched Paper',
            doi: null,
            metadata: { isbn: '978-0-262-03561-3' },
            identifiers: [],
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const repo = new ItemMatchQueryRepository(mockPrisma as never);
      const res = await repo.findMatchCandidates(
        undefined,
        { userId: '11111111-1111-4111-8111-111111111111' },
        { isbn: '978-0-262-03561-3' },
      );

      expect(res.exactMatch).toEqual({
        id: 'matched-id-1',
        title: 'Matched Paper',
        matchReason: 'ISBN_EXACT',
        evidence: { isbn: '9780262035613' },
      });
    });
  });

  describe('BE-P2: Strategy + Registry Pattern for Bibliography Format Detection & Parsing', () => {
    let registry: BibliographyFormatRegistry;

    beforeEach(() => {
      registry = new BibliographyFormatRegistry();
    });

    it('detects all supported bibliography formats from content signatures and hints', () => {
      expect(
        registry.detectRecordFormat(
          '@article{vaswani2017, title={Attention Is All You Need}}',
        ),
      ).toBe('BIBTEX');
      expect(
        registry.detectRecordFormat('TY  - JOUR\nTI  - Deep Learning\nER  -'),
      ).toBe('RIS');
      expect(
        registry.detectRecordFormat('[{"id":"item1","title":"CSL Item"}]'),
      ).toBe('CSL_JSON');
      expect(
        registry.detectRecordFormat(
          '<xml><records><record><titles><title>EndNote</title></titles></record></records></xml>',
        ),
      ).toBe('ENDNOTE_XML');
      expect(
        registry.detectRecordFormat(
          '<modsCollection><mods><titleInfo><title>MODS</title></titleInfo></mods></modsCollection>',
          'ENDNOTE_XML',
        ),
      ).toBe('MODS');
      expect(
        registry.detectRecordFormat(
          '<rdf:RDF xmlns:bib="http://purl.org/net/biblio#"></rdf:RDF>',
        ),
      ).toBe('ZOTERO_RDF');
      expect(
        registry.detectRecordFormat('PMID- 123456\nTI  - Medline Paper'),
      ).toBe('MEDLINE');
      expect(
        registry.detectRecordFormat('"Item Type","Title"\n"book","Clean Code"'),
      ).toBe('CSV');
    });

    it('parses record envelopes through the registered format strategy', async () => {
      const cslEnvelopes = await registry.parseEnvelopes(
        JSON.stringify([
          {
            id: 'vaswani2017',
            type: 'article-journal',
            title: 'Attention Is All You Need',
            DOI: '10.5555/3295222.3295349',
          },
        ]),
        'csl_json',
      );

      expect(cslEnvelopes).toHaveLength(1);
      expect(cslEnvelopes[0].sourceName).toBe('CSL_JSON');
      expect(cslEnvelopes[0].sourceRecordId).toBe('vaswani2017');
      expect(cslEnvelopes[0].rawMetadata.title).toBe(
        'Attention Is All You Need',
      );
    });
  });

  describe('BE-P3: Export Format Strategy Pattern & CslEngineService Single-Pass Cite', () => {
    it('registers all 5 export format strategies and resolves aliases', () => {
      expect(EXPORT_FORMAT_STRATEGIES).toHaveLength(5);
      expect(resolveExportFormatStrategy('bibtex')).toBeInstanceOf(
        BibtexExportStrategy,
      );
      expect(resolveExportFormatStrategy('ris')).toBeInstanceOf(
        RisExportStrategy,
      );
      expect(resolveExportFormatStrategy('csl-json')).toBeInstanceOf(
        CslJsonExportStrategy,
      );
      expect(resolveExportFormatStrategy('csl_json')).toBeInstanceOf(
        CslJsonExportStrategy,
      );
      expect(resolveExportFormatStrategy('csv')).toBeInstanceOf(
        CsvExportStrategy,
      );
      expect(resolveExportFormatStrategy('markdown')).toBeInstanceOf(
        MarkdownExportStrategy,
      );
      expect(resolveExportFormatStrategy('unknown')).toBeUndefined();
    });

    it('formats CSV, Markdown, and CSL-JSON via concrete strategies', () => {
      const sampleItems = [
        {
          id: 'item-1',
          title: 'Deep Learning [Draft]',
          year: 2016,
          itemType: 'book',
          publicationTitle: 'MIT Press',
          doi: '10.1000/dl(2016)',
          citationKey: 'goodfellow2016',
          url: 'https://deeplearningbook.org',
          abstract: null,
          metadata: {},
          updatedAt: new Date('2026-01-01'),
          version: 1,
          contributors: [
            {
              firstName: 'Ian',
              lastName: 'Goodfellow',
              fullName: 'Ian Goodfellow',
              creatorType: 'author',
              orderIndex: 0,
            },
          ],
        },
      ];

      const mockFormatter = {
        formatItem: jest.fn().mockReturnValue({
          bibliography: '@book{goodfellow2016, title={Deep Learning}}',
        }),
      };

      const mdRes = resolveExportFormatStrategy('markdown')!.exportItems({
        items: sampleItems as never,
        timestamp: '2026-10-26',
        truncated: false,
        citationFormatter: mockFormatter,
      });
      expect(mdRes.filename).toBe('library-export-2026-10-26.md');
      expect(mdRes.content).toContain('# Library Export (2026-10-26)');
      expect(mdRes.content).toContain('https://doi.org/10.1000/dl%282016%29');

      const csvRes = resolveExportFormatStrategy('csv')!.exportItems({
        items: sampleItems as never,
        timestamp: '2026-10-26',
        truncated: true,
        citationFormatter: mockFormatter,
      });
      expect(csvRes.truncated).toBe(true);
      expect(csvRes.content).toContain('"goodfellow2016"');

      const cslRes = resolveExportFormatStrategy('csl_json')!.exportItems({
        items: sampleItems as never,
        timestamp: '2026-10-26',
        citationFormatter: mockFormatter,
      });
      expect(cslRes.format).toBe('csl-json');
      const parsed = JSON.parse(cslRes.content) as Array<Record<string, unknown>>;
      expect(parsed[0].title).toBe('Deep Learning [Draft]');
    });

    it('formats citations via CslEngineService without redundant Cite instantiation on fallback', () => {
      const engine = new CslEngineService();
      const res = engine.format(
        {
          id: 'cite-1',
          type: 'article-journal',
          title: 'Single Pass Cite Verification',
          author: [{ family: 'Turing', given: 'Alan' }],
          issued: { 'date-parts': [[1950]] },
        },
        'apa',
      );
      expect(res.bibliography).toContain('Turing');
      expect(res.inText).toContain('Turing');
    });
  });

  describe('BE-P4: Command Pipeline (Chain of Merge Steps) for DuplicateMergerService', () => {
    it('executes metadata backfill, retraction survival, and audit snapshot building cleanly', async () => {
      expect(DEFAULT_DUPLICATE_MERGE_STEPS).toHaveLength(3);

      const primaryMeta: Record<string, unknown> = {
        mergedCitationKeys: ['existingKey'],
        extra: 'Archive: CERN',
      };
      const backfillFields: Record<string, unknown> = {};
      const now = new Date('2026-10-26T00:00:00.000Z');

      const mockTx = {
        itemMetadata: {
          findFirst: jest.fn().mockResolvedValue({ id: 'meta-primary' }),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'meta-dup',
              rawPayload: { isOffloaded: true, fileId: 'offloaded-blob-1' },
            },
          ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        contributor: {
          count: jest.fn().mockResolvedValue(1),
        },
      };

      const offloadedFileIdsToDelete: string[] = [];

      await executeDuplicateMergePipeline({
        tx: mockTx as never,
        primary: {
          id: 'primary-1',
          title: 'Primary Paper',
          citationKey: 'primary2026',
          doi: '10.1000/test',
          metadata: primaryMeta,
        },
        duplicates: [
          {
            id: 'dup-1',
            title: 'Duplicate Paper',
            citationKey: 'dup2026',
            doi: '10.1000/test',
            publisher: 'Springer',
            metadata: {
              arxivId: '2401.12345',
              isRetracted: true,
              retractionNature: 'retraction',
              extra: 'Archive: CERN\nPMID: 12345',
            },
          },
        ],
        uniqueDupIds: ['dup-1'],
        rawSelections: {},
        scalarSelections: {},
        primaryMeta,
        backfillFields,
        offloadedFileIdsToDelete,
        now,
      });

      expect(offloadedFileIdsToDelete).toEqual([]);
      expect(primaryMeta.mergedCitationKeys).toEqual([
        'existingKey',
        'dup2026',
      ]);
      expect(backfillFields.publisher).toBe('Springer');
      expect(primaryMeta.arxivId).toBe('2401.12345');
      expect(primaryMeta.isRetracted).toBe(true);
      expect(primaryMeta.retractionNature).toBe('retraction');
      expect(primaryMeta.extra).toBe('Archive: CERN\nPMID: 12345');

      const audit = buildMergeAuditTrail({
        primary: {
          id: 'primary-1',
          doi: '10.1000/test',
          citationKey: 'primary2026',
        },
        duplicates: [{ doi: '10.1000/test' }],
        uniqueDupIds: ['dup-1'],
        finalPrimary: {
          citationKey: 'primary2026',
          attachments: [{ id: 'a1' }],
          notesList: [],
          itemTags: [],
          collectionItems: [],
        },
        primaryMeta,
        backfillFields,
        now,
      });

      expect(audit.masterItemId).toBe('primary-1');
      expect(audit.matchReasons).toEqual(['EXACT_DOI']);
      expect(audit.preservedCitationKeys).toEqual([
        'primary2026',
        'existingKey',
        'dup2026',
      ]);
      expect(audit.consolidatedAttachments).toBe(1);
      expect(audit.backfilledFields).toContain('publisher');
      expect(typeof applyRetractionSurvivalStep).toBe('function');
      expect(typeof backfillMetadataAndCreatorsStep).toBe('function');
    });
  });

  describe('BE-P5: Rule Object + Strategy Registry for Cross-Type Item Conversion & Field Reconciliation', () => {
    it('registers declarative structural type conversion rules and applies them via ItemTransformer', () => {
      expect(TYPE_CONVERSION_RULES.length).toBeGreaterThanOrEqual(10);
      expect(TYPE_CONVERSION_RULES[0]).toBeInstanceOf(
        BookToBookSectionConversionRule,
      );
      expect(TYPE_CONVERSION_RULES[1]).toBeInstanceOf(
        BookSectionToBookConversionRule,
      );
      expect(TYPE_CONVERSION_RULES[2]).toBeInstanceOf(
        ToConferencePaperConversionRule,
      );
      expect(TYPE_CONVERSION_RULES[3]).toBeInstanceOf(
        ToJournalArticleConversionRule,
      );

      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);

      const bookToSection = transformer.previewConversion(
        {
          id: 'item-book-1',
          itemType: 'book',
          title: 'Designing Data-Intensive Applications',
          publisher: "O'Reilly Media",
          year: 2017,
        },
        'bookSection',
      );
      expect(bookToSection.projectedItem.bookTitle).toBe(
        'Designing Data-Intensive Applications',
      );
      expect(bookToSection.projectedItem.title).toBe('');
      expect(bookToSection.mappedFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromField: 'title',
            toField: 'bookTitle',
            rule: 'special-rule',
          }),
        ]),
      );

      const sectionToBook = transformer.previewConversion(
        {
          id: 'item-sec-1',
          itemType: 'bookSection',
          title: 'Chapter 3: Storage and Retrieval',
          bookTitle: 'Designing Data-Intensive Applications',
        },
        'book',
      );
      expect(sectionToBook.projectedItem.title).toBe(
        'Designing Data-Intensive Applications',
      );
      expect(sectionToBook.unmappedRetained.sectionTitle).toBe(
        'Chapter 3: Storage and Retrieval',
      );

      const confCtx = {
        sourceValues: { publicationTitle: 'NeurIPS 2026' },
        projectedItem: {} as Record<string, unknown>,
        mappedFields: [],
        droppedFields: [],
        unmappedRetained: {},
        newExtraFields: {},
        retainUnmappedInExtra: true,
      };
      applyStructuralTypeConversionRules(
        'journalArticle',
        'conferencePaper',
        confCtx,
      );
      expect(confCtx.projectedItem.proceedingsTitle).toBe('NeurIPS 2026');
    });

    it('reconciles 3-tier priority coalesce (extraFields merge, additive tags/notes union, creator completeness upgrade) cleanly', () => {
      const policy = new ReconciliationPolicy();
      const result = policy.reconcile([
        {
          candidateId: 'c1',
          sourceKind: 'FILE',
          sourceName: 'local_pdf',
          confidenceScore: 0.95,
          retrievedAt: '2026-10-26T00:00:00.000Z',
          schemaVersion: '1.0.0',
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            authors: ['A. Vaswani'],
            tags: ['Transformers', 'Deep Learning'],
            notes: [{ content: 'Initial extraction note' }],
            extraFields: { localKey: 'v1', sharedKey: 'from-local' },
          },
        },
        {
          candidateId: 'c2',
          sourceKind: 'PROVIDER',
          sourceName: 'crossref',
          confidenceScore: 0.9,
          retrievedAt: '2026-10-26T00:00:00.000Z',
          schemaVersion: '1.0.0',
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
            tags: ['deep learning', 'NLP'],
            notes: [
              { content: 'Initial extraction note' },
              { content: 'Publisher note' },
            ],
            extraFields: { crossrefKey: 'v2', sharedKey: 'from-crossref' },
          },
        },
      ]);

      expect(result.proposedItem.authors).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
      ]);
      expect(result.proposedItem.notes).toHaveLength(2);
      expect(result.proposedItem.extraFields).toEqual(
        expect.objectContaining({
          localKey: 'v1',
          crossrefKey: 'v2',
        }),
      );
    });
  });

  describe('BE-P7: Shared Core Specification Pattern (And / Or / Not Composition)', () => {
    class HasDoiSpecification extends CompositeSpecification<
      Record<string, unknown>,
      QueryCriteria
    > {
      toPrismaWhere(): QueryCriteria {
        return { doi: { not: null } };
      }
      isSatisfiedBy(item: Record<string, unknown>): boolean {
        return typeof item?.doi === 'string' && item.doi.trim().length > 0;
      }
    }

    it('composes AndSpecification, OrSpecification, and NotSpecification across in-memory predicates and Prisma where clauses', () => {
      const activeSpec = new ActiveItemsSpecification();
      const recentSpec = new YearRangeSpecification(2022, 2026);
      const doiSpec = new HasDoiSpecification();

      const composite = activeSpec
        .and(recentSpec.or(doiSpec))
        .and(new NotSpecification(new YearRangeSpecification(undefined, 2000)));

      expect(composite).toBeInstanceOf(AndSpecification);
      expect(recentSpec.or(doiSpec)).toBeInstanceOf(OrSpecification);

      const where = composite.toPrismaWhere();
      expect(where).toEqual({
        AND: [
          { deletedAt: null },
          {
            OR: [
              { year: { gte: 2022, lte: 2026 } },
              { doi: { not: null } },
            ],
          },
          {
            NOT: { year: { lte: 2000 } },
          },
        ],
      });

      expect(
        composite.isSatisfiedBy({
          deletedAt: null,
          year: 2024,
          doi: null,
        }),
      ).toBe(true);

      expect(
        composite.isSatisfiedBy({
          deletedAt: null,
          year: 2015,
          doi: '10.1038/nature123',
        }),
      ).toBe(true);

      expect(
        composite.isSatisfiedBy({
          deletedAt: null,
          year: 1998,
          doi: '10.1038/old-paper',
        }),
      ).toBe(false);
    });
  });

  describe('BE-HV1 to BE-HV4: Horizontal & Vertical Backend Pattern Optimizations', () => {
    it('BE-HV2: builds provider results with MD5 rawSnapshotHash + provenance, ranks title candidates, and propagates HTTP 429/5xx', async () => {
      const built = buildAcademicProviderResult({
        provider: 'SemanticScholar',
        identifier: '10.1038/s41586-021-03819-2',
        confidenceScore: 0.92,
        rawPayload: { title: 'AlphaFold', year: 2021 },
        retrievalMethod: 'api',
        sourceUrl: 'https://doi.org/10.1038/s41586-021-03819-2',
        metadata: {
          title: 'Highly accurate protein structure prediction with AlphaFold',
          doi: '10.1038/s41586-021-03819-2',
        },
      });

      expect(built.rawVersion).toMatch(/^[a-f0-9]{32}$/);
      expect(built.metadata.provenance).toEqual(
        expect.objectContaining({
          originProvider: 'SemanticScholar',
          rawSnapshotHash: built.rawVersion,
          confidenceScore: 0.92,
        }),
      );

      const ranked = rankBestTitleCandidate(
        [
          { id: 'c1', title: 'Unrelated Quantum Computing Paper' },
          { id: 'c2', title: 'Attention Is All You Need' },
        ],
        'Attention is all you need',
        (item) => item.title,
      );
      expect(ranked.bestMatch?.id).toBe('c2');
      expect(ranked.bestScore).toBeGreaterThanOrEqual(0.8);

      const dblp = new DblpProvider();
      expect(dblp).toBeInstanceOf(AbstractAcademicProvider);
      expect(dblp.supports({ type: 'DOI' })).toBe(true);

      const originalFetch = global.fetch;
      try {
        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: { get: (k: string) => (k === 'retry-after' ? '3' : null) },
        } as unknown as Response);

        await expect(
          dblp.resolve({ query: '10.1000/rate-limited', queryType: 'DOI' }),
        ).rejects.toThrow(ProviderFetchError);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('BE-HV3: merges empty PDF extraction fields and tracks per-field provenance via PdfExtractionTierContext', async () => {
      const ctx = new PdfExtractionTierContext();

      const tier1: IPdfExtractionTier = {
        tierName: 'XMP_BINARY',
        async executeTier(c) {
          c.mergeFieldIfEmpty('title', 'Untitled', 'XMP_BINARY', 0.95, {
            rejectValuePredicate: (val) => val.toLowerCase() === 'untitled',
          });
          c.mergeFieldIfEmpty('doi', '10.1145/123456', 'XMP_BINARY', 0.95);
        },
      };

      const tier2: IPdfExtractionTier = {
        tierName: 'LAYOUT_HEURISTIC',
        async executeTier(c) {
          c.mergeFieldIfEmpty(
            'title',
            'Deep Residual Learning for Image Recognition',
            'LAYOUT_HEURISTIC',
            0.8,
          );
          c.mergeFieldIfEmpty('doi', '10.1145/overwrite-attempt', 'LAYOUT_HEURISTIC', 0.8);
        },
      };

      await runPdfExtractionTierChain(ctx, [tier1, tier2]);

      expect(ctx.merged.doi).toBe('10.1145/123456');
      expect(ctx.merged.title).toBe(
        'Deep Residual Learning for Image Recognition',
      );
      expect(ctx.provenance.doi).toEqual({
        source: 'XMP_BINARY',
        confidence: 0.95,
      });
      expect(ctx.provenance.title).toEqual({
        source: 'LAYOUT_HEURISTIC',
        confidence: 0.8,
      });
      expect(ctx.tiersExecuted).toEqual(['XMP_BINARY', 'LAYOUT_HEURISTIC']);
    });

    it('BE-HV4: flattens nested AndSpecification / OrSpecification clauses and executes CslEngineService.formatBatchAsync in a single pass with WeakMap fingerprint memoization', async () => {
      class EmptySpec extends CompositeSpecification {
        toPrismaWhere(): QueryCriteria {
          return {};
        }
        isSatisfiedBy(): boolean {
          return true;
        }
      }

      const s1 = new ActiveItemsSpecification();
      const s2 = new YearRangeSpecification(2020, 2025);
      const s3 = new ScopeSpecification('user-1', 'proj-1');
      const empty = new EmptySpec();

      const flattenedAnd = s1.and(empty).and(s2).and(s3).toPrismaWhere();
      expect(flattenedAnd).toEqual({
        AND: [
          { deletedAt: null },
          { year: { gte: 2020, lte: 2025 } },
          { projectId: 'proj-1' },
        ],
      });

      const flattenedOr = s1.or(empty).or(s2).toPrismaWhere();
      expect(flattenedOr).toEqual({
        OR: [{ deletedAt: null }, { year: { gte: 2020, lte: 2025 } }],
      });

      const engine = new CslEngineService();
      const cslItems = [
        {
          id: 'batch-1',
          type: 'article-journal',
          title: 'Paper One',
          author: [{ family: 'Knuth', given: 'Donald' }],
          issued: { 'date-parts': [[1974]] },
        },
        {
          id: 'batch-2',
          type: 'article-journal',
          title: 'Paper Two',
          author: [{ family: 'Dijkstra', given: 'Edsger' }],
          issued: { 'date-parts': [[1968]] },
        },
      ];

      const keyApa = engine.buildCacheKey(cslItems[0], 'apa', 1);
      const keyIeee = engine.buildCacheKey(cslItems[0], 'ieee', 1);
      expect(keyApa).toContain('batch-1::apa::1974');
      expect(keyIeee).toContain('batch-1::ieee::1974');

      const formatSpy = jest.spyOn(engine, 'format');
      const batchRes = await engine.formatBatchAsync(cslItems, 'apa');

      expect(formatSpy).toHaveBeenCalledTimes(2);
      expect(batchRes.citations).toHaveLength(2);
      expect(batchRes.bibliographyText).toContain('Knuth');
      expect(batchRes.bibliographyText).toContain('Dijkstra');
    });
  });

  describe('BE-DEEP1 to BE-DEEP4: Deep-Module & DDD Optimizations', () => {
    it('BE-DEEP1: composes tagId + tag and view=starred + onlyFlagged/readStatus via CompositeSpecification without overwriting', () => {
      const spec = new ItemWhereSpecification(
        { title: 'test' } as never,
        (item) => Boolean(item),
      );
      expect(spec).toBeInstanceOf(CompositeSpecification);

      const whereTags = buildItemWhereClause('user-1', {
        tagId: '11111111-1111-4111-8111-111111111111',
        tag: 'machine-learning',
      });
      expect(whereTags.AND).toEqual(
        expect.arrayContaining([
          { itemTags: { some: { tagId: '11111111-1111-4111-8111-111111111111' } } },
          {
            itemTags: {
              some: {
                tag: {
                  OR: [
                    { name: { equals: 'machine-learning', mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        ]),
      );

      const whereStates = buildItemWhereClause('user-1', {
        view: 'starred',
        onlyFlagged: true,
        readStatus: 'reading',
      });
      expect(whereStates.AND).toEqual(
        expect.arrayContaining([
          { states: { some: { userId: 'user-1', isStarred: true } } },
          { states: { some: { userId: 'user-1', readStatus: 'reading' } } },
        ]),
      );
    });

    it('BE-DEEP1: preserves item filters in ItemListQueryRepository.findMany and count when view === "recent"', async () => {
      const mockStateFindMany = jest.fn().mockResolvedValue([]);
      const mockStateCount = jest.fn().mockResolvedValue(0);
      const mockPrisma = {
        state: {
          findMany: mockStateFindMany,
          count: mockStateCount,
        },
      };
      const repo = new ItemListQueryRepository();
      const validUserId = '11111111-1111-4111-8111-111111111111';
      const filter = {
        view: 'recent' as const,
        itemType: 'journalArticle',
        fromYear: 2020,
        toYear: 2025,
        hasFile: true,
        hasNotes: true,
        isRetracted: true,
        tag: 'nlp',
      };

      await repo.findMany(mockPrisma as never, validUserId, filter);
      await repo.count(mockPrisma as never, validUserId, filter);

      expect(mockStateFindMany).toHaveBeenCalledTimes(1);
      const findManyItemWhere = mockStateFindMany.mock.calls[0][0].where.item;
      expect(findManyItemWhere.itemType).toBe('journalArticle');
      expect(findManyItemWhere.year).toEqual({ gte: 2020, lte: 2025 });
      expect(findManyItemWhere.hasFile).toBe(true);
      expect(findManyItemWhere.noteCount).toEqual({ gt: 0 });
      expect(findManyItemWhere.AND).toEqual(
        expect.arrayContaining([
          { metadata: { path: ['isRetracted'], equals: true } },
        ]),
      );

      expect(mockStateCount).toHaveBeenCalledTimes(1);
      const countItemWhere = mockStateCount.mock.calls[0][0].where.item;
      expect(countItemWhere.itemType).toBe('journalArticle');
      expect(countItemWhere.year).toEqual({ gte: 2020, lte: 2025 });
    });

    it('BE-DEEP1: evaluateExactMatchSpecifications avoids false-positive EXACT_DOI fallback when matched item has a different identifier', () => {
      const input = normalizeExactMatchCandidateInput({
        doi: '10.1000/candidate-doi',
        arxivId: '2402.11111v1',
        pmid: null,
        isbn: null,
      });

      const matchedByArxivOnly = evaluateExactMatchSpecifications(input, {
        id: 'item-arxiv-only',
        title: 'ArXiv Preprint Without DOI',
        doi: null,
        metadata: { arxivId: '2402.11111' },
        identifiers: [],
      });

      expect(matchedByArxivOnly).toEqual({
        id: 'item-arxiv-only',
        title: 'ArXiv Preprint Without DOI',
        matchReason: 'ARXIV_EXACT',
        evidence: { arxivId: '2402.11111v1' },
      });

      const mismatchedDoiRow = evaluateExactMatchSpecifications(input, {
        id: 'item-mismatched',
        title: 'Different DOI Paper',
        doi: '10.9999/different',
        metadata: {},
        identifiers: [],
      });
      expect(mismatchedDoiRow).toBeNull();
    });

    it('BE-DEEP3: CrossRefProvider, OpenAlexProvider, and PubMedProvider extend AbstractAcademicProvider and parse HTTP-date Retry-After headers without NaN', async () => {
      const crossref = new CrossRefProvider();
      const openalex = new OpenAlexProvider();
      const pubmed = new PubMedProvider();

      expect(crossref).toBeInstanceOf(AbstractAcademicProvider);
      expect(openalex).toBeInstanceOf(AbstractAcademicProvider);
      expect(pubmed).toBeInstanceOf(AbstractAcademicProvider);

      const futureDate = new Date(Date.now() + 15000).toUTCString();
      const originalFetch = global.fetch;
      try {
        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: {
            get: (k: string) =>
              k.toLowerCase() === 'retry-after' ? futureDate : null,
          },
        } as unknown as Response);

        for (const { provider, query, queryType } of [
          { provider: crossref, query: '10.1000/http-date-retry', queryType: 'DOI' as const },
          { provider: openalex, query: '10.1000/http-date-retry', queryType: 'DOI' as const },
          { provider: pubmed, query: '31452104', queryType: 'PMID' as const },
        ]) {
          let caught: ProviderFetchError | undefined;
          try {
            await provider.resolve({ query, queryType });
          } catch (err) {
            caught = err as ProviderFetchError;
          }
          expect(caught).toBeInstanceOf(ProviderFetchError);
          expect(caught?.statusCode).toBe(429);
          expect(typeof caught?.retryAfterMs).toBe('number');
          expect(Number.isNaN(caught?.retryAfterMs)).toBe(false);
          expect(caught?.retryAfterMs).toBeGreaterThan(0);
        }
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('BE-DEEP4: unifies bibliographic quality rules between calculateMetadataQualityScore and QualityService.getQualityAudit', async () => {
      expect(BIBLIOGRAPHIC_QUALITY_RULES).toHaveLength(7);

      const itemWithShortTitleAndAncientYear = {
        id: 'item-qual-1',
        title: 'abc',
        doi: '10.1000/valid',
        abstract: 'A sufficiently long abstract exceeding twenty characters.',
        year: 1850,
        contributors: [{ id: 'c1', fullName: 'Author One' }],
        publicationTitle: 'Journal of Testing',
      };

      const breakdown = calculateMetadataQualityScore({
        title: itemWithShortTitleAndAncientYear.title,
        doi: itemWithShortTitleAndAncientYear.doi,
        abstract: itemWithShortTitleAndAncientYear.abstract,
        year: itemWithShortTitleAndAncientYear.year,
        authors: ['Author One'],
        journal: itemWithShortTitleAndAncientYear.publicationTitle,
      });

      expect(breakdown.hasTitle).toBe(false);
      expect(breakdown.hasYear).toBe(false);
      expect(breakdown.hasDoi).toBe(true);

      const diagnosed = diagnoseBibliographicQualityIssues(
        itemWithShortTitleAndAncientYear,
      );
      expect(diagnosed.issues).toEqual(['missing_title', 'missing_year']);
      expect(diagnosed.isHealthy).toBe(false);

      const mockCatalogQuery = {
        findQualityAuditItems: jest
          .fn()
          .mockResolvedValue([itemWithShortTitleAndAncientYear]),
      };
      const qualityService = new QualityService(mockCatalogQuery as never);
      const audit = await qualityService.getQualityAudit('user-1');

      expect(audit.flaggedItems).toHaveLength(1);
      expect(audit.flaggedItems[0].issues).toEqual(['missing_title', 'missing_year']);
    });
  });

  describe('BE-META1 to BE-META5: Metadata Scatter & Business Workflow Consolidation', () => {
    it('BE-META1: fixes __unmapped_ off-by-one key stripping, space/hyphen Extra key normalization, and preprint-to-journalArticle repository pollution', async () => {
      const domainItem = ItemsMapper.toDomain({
        id: 'item-unmapped-1',
        title: 'Converted Book Item',
        itemType: 'book',
        publicationTitle: null,
        metadata: {
          __unmapped_journalArticle_publicationTitle: 'Journal of Machine Learning',
          extra: 'Publication Title: Journal of Machine Learning\nReport-Number: TR-99',
        },
      });
      // Unmapped retained field must NOT leak back into top-level publicationTitle or extraFields
      expect(domainItem.publicationTitle).toBe('');
      expect(domainItem.extraFields?.publicationTitle).toBeUndefined();
      expect(domainItem.extraFields?.reportNumber).toBe('TR-99');

      // resolveExtraPlainText deduplicates space/hyphen Extra keys against camelCase patch keys
      const deduplicatedExtra = resolveExtraPlainText(
        undefined,
        'Publication Title: Old Venue\nCitation-Key: oldKey\nKeep Line: Value',
        {
          publicationTitle: 'New Venue',
          citationKey: 'newKey2026',
        },
        ['Publication Title: Duplicate Demoted'],
      );
      expect(deduplicatedExtra).toBe(
        'Publication Title: New Venue\nCitation-Key: newKey2026\nKeep Line: Value',
      );

      // Preprint -> journalArticle conversion does not pollute publicationTitle with virtual "arXiv" repository
      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);
      const mockQuery = {
        findById: jest.fn().mockResolvedValue({
          id: 'preprint-1',
          userId: 'user-1',
          projectId: null,
          title: 'Attention Is All You Need',
          itemType: 'preprint',
          publicationTitle: null,
          doi: '10.48550/arXiv.1706.03762',
          version: 1,
          metadata: {
            itemType: 'preprint',
            arxivId: '1706.03762',
            repository: 'arXiv',
          },
        }),
      };
      const mockCommand = {
        update: jest.fn().mockImplementation((_uid, id, _ver, patch) =>
          Promise.resolve({
            id,
            title: 'Attention Is All You Need',
            itemType: patch.itemType,
            publicationTitle: patch.publicationTitle ?? null,
            version: 2,
            metadata: { itemType: patch.itemType, ...patch.extraFields },
          }),
        ),
      };
      const mockCacheCoordinator = {
        invalidateItemCache: jest.fn().mockResolvedValue(undefined),
      };
      const mockHelpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        recordTombstone: jest.fn().mockResolvedValue(undefined),
      };

      const conversionService = new ItemTypeConversionService(
        mockQuery as never,
        mockCommand as never,
        typesService,
        transformer,
        undefined,
        mockCacheCoordinator as never,
      );

      const converted = await conversionService.convertItemType(
        'user-1',
        'preprint-1',
        'journalArticle',
        { retainUnmappedInExtra: true },
        undefined,
        {} as never,
        mockHelpers as never,
      );

      expect(converted.item.itemType).toBe('journalArticle');
      expect(converted.item.publicationTitle).toBe('');
      expect(mockHelpers.appendChange).toHaveBeenCalledTimes(1);
      expect(mockHelpers.publishOutbox).toHaveBeenCalledTimes(1);
      expect(mockCacheCoordinator.invalidateItemCache).toHaveBeenCalledWith(
        'preprint-1',
        'user-1',
        undefined,
      );
    });

    it('BE-META2: normalizes arxivId to canonical arxiv in ItemIdentifier sync and recalculates firstAuthor when contributors merge', async () => {
      const upsertedIdentifiers: unknown[] = [];
      const mockTx = {
        itemIdentifier: {
          findMany: jest.fn().mockResolvedValue([
            { itemId: 'dup-1', type: 'arxivId', value: '2401.12345', canonicalUri: '2401.12345' },
          ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          upsert: jest.fn().mockImplementation((args) => {
            upsertedIdentifiers.push(args);
            return Promise.resolve(args);
          }),
        },
        contributor: {
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      await syncMergedIdentifiersInTx({
        tx: mockTx as never,
        primaryId: 'primary-1',
        uniqueDupIds: ['dup-1'],
        primaryMeta: { arxivId: '2401.12345' },
        topLevelData: {},
        primaryDoi: null,
      });

      expect(upsertedIdentifiers).toHaveLength(1);
      expect(upsertedIdentifiers[0]).toEqual(
        expect.objectContaining({
          where: { itemId_type: { itemId: 'primary-1', type: 'arxiv' } },
        }),
      );

      const backfillFields: Record<string, unknown> = {};
      await backfillMetadataAndCreatorsStep({
        tx: mockTx as never,
        primary: { id: 'primary-1', metadata: {} },
        duplicates: [
          {
            id: 'dup-1',
            contributors: [
              { firstName: 'Geoffrey', lastName: 'Hinton', fullName: 'Geoffrey Hinton', creatorType: 'author', orderIndex: 0 },
            ],
          },
        ],
        uniqueDupIds: ['dup-1'],
        rawSelections: {},
        scalarSelections: {},
        primaryMeta: {},
        backfillFields,
        offloadedFileIdsToDelete: [],
        now: new Date(),
      });

      expect(backfillFields.firstAuthor).toBe('Hinton');
    });

    it('BE-META3: soft-deletes duplicate attachments on merge without immediate hard delete', async () => {
      const updatedAttachments: unknown[] = [];
      const mockPrisma = {
        attachment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'att-master',
              itemId: 'master-1',
              fileHash: 'sha256-same',
              attachmentType: 'primary_pdf',
              fileId: 'file-shared',
              annotations: [],
              revisions: [],
            },
            {
              id: 'att-dup',
              itemId: 'dup-1',
              fileHash: 'sha256-same',
              attachmentType: 'primary_pdf',
              fileId: 'file-dup-only',
              annotations: [],
              revisions: [],
            },
          ]),
          update: jest.fn().mockImplementation((args) => {
            updatedAttachments.push(args);
            return Promise.resolve(args);
          }),
          delete: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
        item: {
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const attachmentsRepo = new AttachmentsRepository(mockPrisma as never);
      const orphanedFileIds = await attachmentsRepo.reassignToItem(
        ['dup-1'],
        'master-1',
        mockPrisma as never,
      );

      // S3 fileId must NOT be returned as orphaned for immediate deletion
      expect(orphanedFileIds).toEqual([]);
      expect(mockPrisma.attachment.delete).not.toHaveBeenCalled();
      expect(updatedAttachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            where: { id: 'att-dup' },
            data: expect.objectContaining({ deletedAt: expect.any(Date) }),
          }),
        ]),
      );
    });

    it('BE-META5: unifies ReconciliationPolicy with FieldReconciliationStrategies, aligns conflicting publicationDate/year, and additively enriches Extra', () => {
      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([
        {
          candidateId: 'cand-arxiv',
          sourceKind: 'PROVIDER',
          sourceName: 'arXiv',
          sourceProvider: 'arxiv',
          retrievedAt: '2026-10-26T00:00:00.000Z',
          overallConfidence: 0.9,
          normalizedMetadata: {},
          fields: {
            title: {
              rawValue: 'Paper Title',
              normalizedValue: 'Paper Title',
              confidence: 0.95,
              sourceProvider: 'arxiv',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            year: {
              rawValue: 2023,
              normalizedValue: 2023,
              confidence: 0.9,
              sourceProvider: 'arxiv',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            publicationDate: {
              rawValue: '2023-05-10',
              normalizedValue: '2023-05-10',
              confidence: 0.95,
              sourceProvider: 'arxiv',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            extra: {
              rawValue: 'arXiv: 2305.00001',
              normalizedValue: 'arXiv: 2305.00001',
              confidence: 0.95,
              sourceProvider: 'arxiv',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
          },
        },
        {
          candidateId: 'cand-crossref',
          sourceKind: 'PROVIDER',
          sourceName: 'CrossRef',
          sourceProvider: 'crossref',
          retrievedAt: '2026-10-26T00:00:00.000Z',
          overallConfidence: 0.98,
          normalizedMetadata: {},
          fields: {
            title: {
              rawValue: 'Paper Title',
              normalizedValue: 'Paper Title',
              confidence: 0.98,
              sourceProvider: 'crossref',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            year: {
              rawValue: 2024,
              normalizedValue: 2024,
              confidence: 0.98,
              sourceProvider: 'crossref',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            extra: {
              rawValue: 'PMID: 11223344',
              normalizedValue: 'PMID: 11223344',
              confidence: 0.9,
              sourceProvider: 'crossref',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
          },
        },
      ]);

      expect(decision.proposedItem.year).toBe(2024);
      // Conflicting 2023-05-10 publicationDate from arxiv is aligned to winning 2024 year
      expect(decision.proposedItem.publicationDate).toBe('2024');
      expect(decision.selectedFields.publicationDate.normalizedValue).toBe('2024');
      // Extra lines from both providers are additively merged via ExtraFieldsMergeReconciliationStrategy
      expect(decision.proposedItem.extra).toContain('arXiv: 2305.00001');
      expect(decision.proposedItem.extra).toContain('PMID: 11223344');

      // buildEnrichmentPatch additively merges new Extra lines without overwriting existing keys
      const enrichPatch = buildEnrichmentPatch(
        {
          title: 'Existing Paper',
          extra: 'arXiv: 2305.00001\nCitation Key: existing2023',
        },
        {
          extra: 'arXiv: 9999.99999\nPMID: 55667788\nCitation-Key: ignored2024',
        },
      );
      expect(enrichPatch.extra).toBe(
        'arXiv: 2305.00001\nCitation Key: existing2023\nPMID: 55667788',
      );
    });
  });

  describe('Cycle-3 BE-SYS-META1 through BE-SYS-META5 Architectural & Consistency Verification', () => {
    it('BE-SYS-META1: consolidates ItemMetadata rows by reassigning unique providers to primary during merge', async () => {
      const updatedMetadata: Array<{ where: { id: string }; data: { itemId: string } }> = [];
      const mockTxMeta = {
        itemMetadata: {
          findMany: jest.fn().mockImplementation(async (args: { where?: { itemId?: unknown } }) => {
            if (args?.where?.itemId === 'primary-1') {
              return [
                { id: 'meta-p1', itemId: 'primary-1', sourceProvider: 'crossref', rawPayload: { doi: '10.1000/1' } },
                { id: 'meta-p2', itemId: 'primary-1', sourceProvider: 'mextract', rawPayload: { title: 'Paper' } },
              ];
            }
            return [
              { id: 'meta-d1', itemId: 'dup-1', sourceProvider: 'openalex', rawPayload: { id: 'W1' } },
            ];
          }),
          update: jest.fn().mockImplementation(async (args) => {
            updatedMetadata.push(args);
            return {};
          }),
        },
      };

      const stepCtx = {
        tx: mockTxMeta as never,
        primary: { id: 'primary-1' },
        duplicates: [{ id: 'dup-1' }],
        uniqueDupIds: ['dup-1'],
        offloadedFileIdsToDelete: [] as string[],
      };
      await consolidateItemMetadataStep(stepCtx as never);
      expect(updatedMetadata).toHaveLength(1);
      expect(updatedMetadata[0]).toEqual({
        where: { id: 'meta-d1' },
        data: { itemId: 'primary-1' },
      });
    });

    it('BE-SYS-META2: ExtractionMetadataSynchronizer.buildMetadataSyncPlan passes delta-only metaPatch and wraps relation-only backfills in transaction with outbox events', async () => {
      const { ExtractionMetadataSynchronizer } = await import(
        '@/modules/library/extraction/services/extraction-metadata.synchronizer'
      );

      const mockRepo = {
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({ id: 'src-1' }),
        syncExtractedIdentifiers: jest.fn().mockResolvedValue(undefined),
        countContributors: jest.fn().mockResolvedValue(0),
        createContributors: jest.fn().mockResolvedValue(undefined),
        countItemTags: jest.fn().mockResolvedValue(0),
        syncItemTags: jest.fn().mockResolvedValue(undefined),
        countItemNotes: jest.fn().mockResolvedValue(0),
        createItemNotes: jest.fn().mockResolvedValue(undefined),
        updateItem: jest.fn().mockResolvedValue({
          id: 'item-sync-1',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Existing Good Title',
          version: 3,
          metadata: { tags: ['neural-nets'] },
          contributors: [{ firstName: 'Geoffrey', lastName: 'Hinton', creatorType: 'author' }],
        }),
      };
      const helpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
      };
      const mockLibraryTx = {
        executeInTransaction: jest.fn(async (cb: (tx: unknown, h: unknown) => Promise<unknown>) =>
          cb({}, helpers),
        ),
      };

      const synchronizer = new ExtractionMetadataSynchronizer(
        mockRepo as never,
        mockLibraryTx as never,
      );

      const plan = synchronizer.buildMetadataSyncPlan(
        {
          id: 'att-1',
          itemId: 'item-sync-1',
          item: {
            id: 'item-sync-1',
            userId: '550e8400-e29b-41d4-a716-446655440000',
            title: 'Untitled Document',
            doi: null,
            metadata: { tags: ['stale-pre-tx-tag'], customExisting: 'keep-in-db' },
          },
        },
        {
          metadata: {
            title: 'Extracted Real Title',
            doi: '10.1038/nature14539',
            pmcid: 'PMC3184628',
            keywords: ['deep-learning'],
          },
        },
      );

      // itemPatch.metadata contains ONLY the delta metaPatch (never spreading stale existingItemMeta.tags)
      const patchMeta = plan.itemPatch.metadata as Record<string, unknown>;
      expect(patchMeta.tags).toBeUndefined();
      expect(patchMeta.doi).toBe('10.1038/nature14539');
      expect(patchMeta.title).toBe('Extracted Real Title');
      expect(patchMeta.pmcid).toBe('PMC3184628');
      expect(plan.extractedIdentifiers).toEqual(
        expect.arrayContaining([
          {
            type: 'pmcid',
            value: 'PMC3184628',
            canonicalUri: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3184628/',
          },
        ]),
      );

      // Relation-only backfill (item already has title/doi/year/abstract/publicationTitle/citationKey, only keywords/contributors extracted)
      await synchronizer.offloadFullTextAndSyncMetadata(
        {
          id: 'att-2',
          itemId: 'item-sync-1',
          item: {
            id: 'item-sync-1',
            userId: '550e8400-e29b-41d4-a716-446655440000',
            title: 'Existing Good Title',
            doi: '10.1038/nature14539',
            abstract: 'Existing abstract',
            year: 2015,
            publicationTitle: 'Nature',
            citationKey: 'hinton2015deep',
            metadata: {},
          } as never,
        },
        {
          metadata: {
            keywords: ['neural-nets'],
            authors: ['Geoffrey Hinton'],
          },
        },
        { text: 'Full text body' },
      );

      expect(mockLibraryTx.executeInTransaction).toHaveBeenCalledTimes(1);
      expect(helpers.appendChange).toHaveBeenCalledTimes(1);
      expect(helpers.publishOutbox).toHaveBeenCalledTimes(1);
    });

    it('BE-SYS-META3: ReconciliationPolicy harmonizes aliases/base-fields without double-weighting EnrichedProvider, and TrustedExtractionService executes via runPdfExtractionTierChain', async () => {
      const { MetadataCoalescePolicy: ReconciliationPolicy } = await import(
        '@/modules/library/core'
      );
      const { TrustedExtractionService } = await import(
        '@/modules/library/extraction/services/trusted-extraction.service'
      );
      const tierChainMod = await import(
        '@/modules/library/extraction/domain/attachments.domain'
      );

      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([
        {
          candidateId: 'c-1',
          sourceKind: 'PROVIDER',
          sourceName: 'EnrichedProvider',
          sourceProvider: 'crossref',
          retrievedAt: '2026-10-26T00:00:00.000Z',
          normalizedMetadata: {},
          fields: {
            title: {
              path: 'title',
              value: 'Harmonized Paper',
              normalizedValue: 'Harmonized Paper',
              confidence: 0.9,
              sourceProvider: 'crossref',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            journal: {
              path: 'journal',
              value: 'Journal of AI Research',
              normalizedValue: 'Journal of AI Research',
              confidence: 0.92,
              sourceProvider: 'crossref',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
            abstractNote: {
              path: 'abstractNote',
              value: 'Detailed abstract note from provider.',
              normalizedValue: 'Detailed abstract note from provider.',
              confidence: 0.88,
              sourceProvider: 'crossref',
              retrievedAt: '2026-10-26T00:00:00.000Z',
            },
          },
        },
      ]);

      expect(decision.proposedItem.publicationTitle).toBe('Journal of AI Research');
      expect(decision.proposedItem.abstract).toBe('Detailed abstract note from provider.');
      expect(decision.selectedFields.publicationTitle).toBeDefined();
      expect(decision.selectedFields.abstract).toBeDefined();

      const spyChain = jest.spyOn(tierChainMod, 'runPdfExtractionTierChain');
      const extractor = new TrustedExtractionService();
      const tiers = extractor.buildExtractionTiers(Buffer.from('%PDF-1.4 mock'));
      expect(tiers.map((t) => t.tierName)).toEqual([
        'XMP_BINARY',
        'ACADEMIC_REGEX',
        'LAYOUT_HEURISTIC',
        'MEXTRACT_SLM',
      ]);
      await extractor.extract(Buffer.from('%PDF-1.4 mock'), 'sample_paper.pdf');
      expect(spyChain).toHaveBeenCalled();
      spyChain.mockRestore();
    });

    it('BE-SYS-META4: QueryRepository includes identifiers, PMCID URI is canonical across mappers, and BIBLIOGRAPHIC_QUALITY_RULES recognizes pmcid', async () => {
      const { QueryRepository } = await import(
        '@/modules/library/catalog/repositories/query.repository'
      );
      const { ItemsMapper } = await import(
        '@/modules/library/catalog/domain/items.mapper'
      );
      const { IDENTIFIER_URI_BUILDERS } = await import(
        '@/modules/library/catalog/domain/identifier-change.helper'
      );
      const { calculateMetadataQualityScore } = await import(
        '@/modules/library/ingestion/domain/metadata.validator'
      );

      const mockPrisma = {
        item: {
          findFirst: jest.fn().mockResolvedValue({
            id: '550e8400-e29b-41d4-a716-446655440001',
            userId: '550e8400-e29b-41d4-a716-446655440000',
            title: 'PMCID Paper',
            itemType: 'journalArticle',
            metadata: { pmcid: 'PMC3184628' },
            identifiers: [
              {
                type: 'pmcid',
                value: 'PMC3184628',
                canonicalUri: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3184628/',
              },
            ],
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const queryRepo = new QueryRepository(mockPrisma as never);
      await queryRepo.findById(
        '550e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440001',
      );
      await queryRepo.findByIds(
        '550e8400-e29b-41d4-a716-446655440000',
        ['550e8400-e29b-41d4-a716-446655440001'],
      );
      expect(mockPrisma.item.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );
      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );

      const domainItem = ItemsMapper.toDomain({
        id: '550e8400-e29b-41d4-a716-446655440002',
        title: 'Fallback PMCID Mapper Test',
        itemType: 'journalArticle',
        metadata: { pmcid: 'PMC3184628' },
      });
      const pmcidIdent = domainItem.identifiers?.find((i) => i.type === 'pmcid');
      const pmcidBuilder = IDENTIFIER_URI_BUILDERS.find((b) => b.type === 'pmcid');
      expect(pmcidIdent?.canonicalUri).toBe(
        pmcidBuilder?.buildUri('PMC3184628'),
      );
      expect(pmcidIdent?.canonicalUri).toBe(
        'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3184628/',
      );

      const report = calculateMetadataQualityScore({
        title: 'Biomedical Paper With Only PMCID',
        authors: ['Jane Doe'],
        year: 2024,
        publicationTitle: 'BMJ',
        abstract: 'Clinical study results.',
        pmcid: 'PMC3184628',
      });
      expect(report.hasIdentifier).toBe(true);
      expect(report.missingKeyFields).not.toContain('identifier');
    });

    it('BE-SYS-META5: CslEngineService fingerprint includes extended CSL fields/creators and ItemTypeConversionService remaps invalid creator roles', async () => {
      const { CslEngineService } = await import(
        '@/modules/library/citation/services/csl-engine.service'
      );
      const { buildCommandUpdateInput } = await import(
        '@/modules/library/catalog/domain/command-payload.builder'
      );

      const cslEngine = new CslEngineService();
      const baseCsl = {
        id: 'item-1',
        type: 'motion_picture',
        title: 'Oppenheimer',
        director: [{ family: 'Nolan', given: 'Christopher' }],
        'container-title-short': 'Univ. Pict.',
        'event-place': 'Los Angeles',
        'number-of-pages': '180',
        status: 'released',
        medium: '35mm film',
      };
      const mutatedDirectorCsl = {
        ...baseCsl,
        director: [{ family: 'Villeneuve', given: 'Denis' }],
      };
      const mutatedShortTitleCsl = {
        ...baseCsl,
        'container-title-short': 'Warner Bros.',
      };

      const key1 = cslEngine.buildCacheKey(baseCsl as never, 'apa');
      const key2 = cslEngine.buildCacheKey(mutatedDirectorCsl as never, 'apa');
      const key3 = cslEngine.buildCacheKey(mutatedShortTitleCsl as never, 'apa');
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);

      // Item type conversion from film/videoRecording (with 'director') to 'journalArticle' remaps invalid 'director' role to 'author'
      const { updateData } = buildCommandUpdateInput(
        '550e8400-e29b-41d4-a716-446655440000',
        {
          id: '550e8400-e29b-41d4-a716-446655440099',
          title: 'Documentary Study',
          itemType: 'videoRecording',
          contributors: [
            {
              creatorType: 'director',
              firstName: 'Christopher',
              lastName: 'Nolan',
              fullName: 'Christopher Nolan',
              orderIndex: 0,
            },
          ],
        },
        {
          itemType: 'journalArticle',
        },
      );
      const createdContribs = (
        updateData.contributors as { create?: Array<{ creatorType: string; lastName: string }> }
      )?.create;
      expect(createdContribs).toEqual([
        expect.objectContaining({
          creatorType: 'author',
          lastName: 'Nolan',
        }),
      ]);
    });
  });
});
