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
  RetractionSurvivalMergeStep,
  MetadataAndCreatorBackfillMergeStep,
  AuditSnapshotBuilder,
  executeDuplicateMergePipeline,
} from '@/modules/library/ingestion/domain/duplicate-merge.steps';
import {
  TYPE_CONVERSION_RULES,
  applyStructuralTypeConversionRules,
  BookToBookSectionConversionRule,
  BookSectionToBookConversionRule,
  ToConferencePaperConversionRule,
  ToJournalArticleConversionRule,
} from '@/modules/library/catalog/domain/type-conversion-rules.domain';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import {
  FIELD_RECONCILIATION_STRATEGIES,
  resolveFieldReconciliationStrategy,
  ExtraFieldsMergeReconciliationStrategy,
  AppendOnlyUniqueArrayReconciliationStrategy,
  CreatorCompletenessReconciliationStrategy,
  ScalarTrustHierarchyReconciliationStrategy,
} from '@/modules/library/ingestion/domain/field-reconciliation.strategies';
import { MetadataReconciliationService } from '@/modules/library/ingestion/services/metadata-reconciliation.service';
import {
  createDuplicateMergeMemento,
  serializeMergeMemento,
  parseMergeMemento,
  buildMasterRestoreData,
} from '@/modules/library/ingestion/domain/duplicate-merge.memento';
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
} from '@/modules/library/extraction/domain/pdf-extraction-tier.chain';
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
import { QualityService } from '@/modules/library/ingestion/services/quality.service';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { resolveExtraPlainText } from '@/modules/library/catalog/domain/creator-tag-payload.builder';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';
import { syncMergedIdentifiersInTx } from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
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

      const audit = AuditSnapshotBuilder.build({
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
      expect(new RetractionSurvivalMergeStep().stepName).toBe(
        'RETRACTION_AND_PUBLICATION_SURVIVAL',
      );
      expect(new MetadataAndCreatorBackfillMergeStep().stepName).toBe(
        'METADATA_AND_CREATOR_BACKFILL',
      );
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

    it('resolves and executes all 4 Field Reconciliation Strategies cleanly', () => {
      expect(FIELD_RECONCILIATION_STRATEGIES).toHaveLength(4);
      expect(resolveFieldReconciliationStrategy('extraFields')).toBeInstanceOf(
        ExtraFieldsMergeReconciliationStrategy,
      );
      expect(resolveFieldReconciliationStrategy('tags')).toBeInstanceOf(
        AppendOnlyUniqueArrayReconciliationStrategy,
      );
      expect(resolveFieldReconciliationStrategy('notes')).toBeInstanceOf(
        AppendOnlyUniqueArrayReconciliationStrategy,
      );
      expect(resolveFieldReconciliationStrategy('creators')).toBeInstanceOf(
        CreatorCompletenessReconciliationStrategy,
      );
      expect(resolveFieldReconciliationStrategy('authors')).toBeInstanceOf(
        CreatorCompletenessReconciliationStrategy,
      );
      expect(resolveFieldReconciliationStrategy('title')).toBeInstanceOf(
        ScalarTrustHierarchyReconciliationStrategy,
      );

      const reconciliationService = new MetadataReconciliationService();
      const result = reconciliationService.reconcile([
        {
          sourceProvider: 'local_pdf',
          confidenceScore: 0.95,
          metadata: {
            title: 'Attention Is All You Need',
            authors: ['A. Vaswani'],
            tags: ['Transformers', 'Deep Learning'],
            notes: ['Initial extraction note'],
            extraFields: { localKey: 'v1', sharedKey: 'from-local' },
          },
          retrievedAt: '2026-10-26T00:00:00.000Z',
        },
        {
          sourceProvider: 'crossref',
          confidenceScore: 0.9,
          metadata: {
            title: 'Attention Is All You Need',
            authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
            tags: ['deep learning', 'NLP'],
            notes: ['Initial extraction note', 'Publisher note'],
            extraFields: { crossrefKey: 'v2', sharedKey: 'from-crossref' },
          },
          retrievedAt: '2026-10-26T00:00:00.000Z',
        },
      ]);

      expect(result.metadata.authors).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
      ]);
      expect(result.metadata.notes).toHaveLength(2);
      expect(result.metadata.extraFields).toEqual(
        expect.objectContaining({
          localKey: 'v1',
          crossrefKey: 'v2',
        }),
      );
    });
  });

  describe('BE-P6: Domain Memento Pattern for Reversible Duplicate Merge (undoMerge)', () => {
    it('serializes, parses, and restores master + soft-deleted duplicates via DuplicateMergerService.undoMerge', async () => {
      const memento = createDuplicateMergeMemento({
        primary: {
          id: 'master-1',
          title: 'Pre-Merge Master Title',
          year: 2024,
          doi: '10.1000/master',
          metadata: { customKey: 'original', extra: 'Line 1' },
        },
        duplicates: [
          {
            id: 'dup-1',
            title: 'Duplicate Item 1',
            citationKey: 'dup2024a',
            doi: '10.1000/master',
            metadata: { source: 'arxiv' },
          },
          {
            id: 'dup-2',
            title: 'Duplicate Item 2',
            citationKey: 'dup2024b',
            doi: null,
            metadata: { source: 'bibtex' },
          },
        ],
        uniqueDupIds: ['dup-1', 'dup-2'],
        mergedMetadataFields: ['publisher'],
        reassignedNoteIds: ['note-1'],
        reassignedAttachmentIds: ['att-1'],
        mergedCreatorCount: 3,
        now: new Date('2026-10-26T12:00:00.000Z'),
      });

      const serialized = serializeMergeMemento(memento);
      const parsed = parseMergeMemento(serialized);
      expect(parsed).not.toBeNull();
      expect(parsed!.masterItemId).toBe('master-1');
      expect(parsed!.mergedDuplicateIds).toEqual(['dup-1', 'dup-2']);
      expect(parsed!.beforeMaster?.title).toBe('Pre-Merge Master Title');

      const restoreData = buildMasterRestoreData(parsed!, {
        customKey: 'modified',
        publisher: 'Backfilled Publisher',
        lastMergeMemento: serialized,
      });
      expect(restoreData.scalarData.title).toBe('Pre-Merge Master Title');
      expect(restoreData.restoredMetadata).toEqual({
        customKey: 'original',
        extra: 'Line 1',
      });

      const updatedItems: Array<{ where: unknown; data: unknown }> = [];
      const appendedChanges: unknown[] = [];
      const publishedEvents: unknown[] = [];

      const mockTx = {
        duplicateMergeAudit: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'audit-1',
            masterItemId: 'master-1',
            snapshotJson: serialized,
          }),
        },
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'master-1',
            title: 'Mutated Master Title',
            metadata: {
              customKey: 'modified',
              lastMergeMemento: serialized,
            },
          }),
          update: jest.fn().mockImplementation((args) => {
            updatedItems.push(args);
            return Promise.resolve({
              id: args.where.id,
              ...args.data,
              version: 2,
            });
          }),
        },
      };

      const mockHelpers = {
        appendChange: jest.fn().mockImplementation((_scope, change) => {
          appendedChanges.push(change);
          return Promise.resolve();
        }),
        publishOutbox: jest
          .fn()
          .mockImplementation((_scope, id, eventType, payload) => {
            publishedEvents.push({ id, eventType, payload });
            return Promise.resolve();
          }),
        recordTombstone: jest.fn(),
      };

      const mockLibraryTx = {
        executeInTransaction: jest
          .fn()
          .mockImplementation((fn) => fn(mockTx, mockHelpers)),
      };

      const mergerService = new DuplicateMergerService(mockLibraryTx as never);
      const undoRes = await mergerService.undoMerge('user-1', 'master-1');

      expect(undoRes).toEqual({
        restoredPrimaryId: 'master-1',
        restoredDuplicateIds: ['dup-1', 'dup-2'],
      });
      expect(updatedItems).toHaveLength(3);
      expect(updatedItems[1]).toEqual(
        expect.objectContaining({
          where: { id: 'dup-1' },
          data: expect.objectContaining({
            deletedAt: null,
            title: 'Duplicate Item 1',
            citationKey: 'dup2024a',
          }),
        }),
      );
      expect(appendedChanges).toHaveLength(3);
      expect(publishedEvents).toHaveLength(3);
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
    it('BE-HV1: captures and restores relational state (attachments, notes, tags, collections, identifiers) in Relational Memento v2', async () => {
      const memento = createDuplicateMergeMemento({
        primary: {
          id: 'master-rel-1',
          title: 'Master Title',
          tagIds: ['tag-master-only'],
          collectionIds: ['col-master-only'],
          contributors: [{ fullName: 'Ada Lovelace', orderIndex: 0 }],
          identifiers: [{ type: 'doi', value: '10.1000/master' }],
        },
        duplicates: [
          {
            id: 'dup-rel-1',
            title: 'Duplicate Title',
            attachmentIds: ['att-dup-1'],
            noteIds: ['note-dup-1'],
            tagIds: ['tag-dup-1'],
            collectionIds: ['col-dup-1'],
            identifiers: [{ type: 'arxivId', value: '2401.99999' }],
          },
        ],
        uniqueDupIds: ['dup-rel-1'],
      });

      const serialized = serializeMergeMemento(memento);
      const parsed = parseMergeMemento(serialized);
      expect(parsed?.schemaVersion).toBe(2);
      expect(parsed?.beforeMaster?.tagIds).toEqual(['tag-master-only']);
      expect(parsed?.mergedDuplicates?.[0]?.attachmentIds).toEqual(['att-dup-1']);
      expect(parsed?.mergedDuplicates?.[0]?.noteIds).toEqual(['note-dup-1']);
      expect(parsed?.mergedDuplicates?.[0]?.tagIds).toEqual(['tag-dup-1']);
      expect(parsed?.mergedDuplicates?.[0]?.collectionIds).toEqual(['col-dup-1']);
      expect(parsed?.mergedDuplicates?.[0]?.identifiers).toEqual([
        { type: 'arxivId', value: '2401.99999' },
      ]);

      const mockTx = {
        duplicateMergeAudit: {
          findFirst: jest.fn().mockResolvedValue({
            masterItemId: 'master-rel-1',
            snapshotJson: serialized,
          }),
        },
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'master-rel-1',
            metadata: {},
          }),
          update: jest.fn().mockImplementation((args) =>
            Promise.resolve({ id: args.where.id, ...args.data, version: 2 }),
          ),
        },
        attachment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        note: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        itemTag: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        collectionItem: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        contributor: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        itemIdentifier: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const mockHelpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        recordTombstone: jest.fn().mockResolvedValue(undefined),
      };

      const mergerService = new DuplicateMergerService({
        executeInTransaction: jest
          .fn()
          .mockImplementation((fn) => fn(mockTx, mockHelpers)),
      } as never);

      await mergerService.undoMerge('user-1', 'master-rel-1');

      expect(mockTx.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['att-dup-1'] }, itemId: 'master-rel-1' },
        data: { itemId: 'dup-rel-1' },
      });
      expect(mockTx.note.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['note-dup-1'] }, itemId: 'master-rel-1' },
        data: { itemId: 'dup-rel-1' },
      });
      expect(mockTx.itemTag.createMany).toHaveBeenCalledWith({
        data: [{ itemId: 'dup-rel-1', tagId: 'tag-dup-1' }],
        skipDuplicates: true,
      });
      expect(mockTx.collectionItem.createMany).toHaveBeenCalledWith({
        data: [{ itemId: 'dup-rel-1', collectionId: 'col-dup-1' }],
        skipDuplicates: true,
      });
      expect(mockTx.itemIdentifier.createMany).toHaveBeenCalledWith({
        data: [
          {
            itemId: 'dup-rel-1',
            type: 'arxivId',
            value: '2401.99999',
            canonicalUri: '2401.99999',
          },
        ],
        skipDuplicates: true,
      });
    });

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
      const spec = new ItemWhereSpecification({ description: 'test' }, (item) =>
        Boolean(item),
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

    it('BE-DEEP2: restores aggregate-complete v3 relations (contributors, itemRelations, userPublications, userStates, itemMetadata, overwritten identifiers) and pops audit stack on undoMerge', async () => {
      const olderMemento = createDuplicateMergeMemento({
        primary: { id: 'master-v3', title: 'Original Master v0' },
        duplicates: [{ id: 'dup-older', title: 'Older Dup' }],
        uniqueDupIds: ['dup-older'],
      });
      const olderSerialized = serializeMergeMemento(olderMemento);

      const latestMemento = createDuplicateMergeMemento({
        primary: {
          id: 'master-v3',
          title: 'Master Before Second Merge',
          identifiers: [{ type: 'doi', value: '10.1000/master-original' }],
          itemRelations: [
            {
              id: 'rel-master-1',
              sourceItemId: 'master-v3',
              targetItemId: 'other-1',
              relationType: 'cites',
            },
          ],
          userPublications: [
            { userId: 'user-1', itemId: 'master-v3', isPublic: true },
          ],
          userStates: [
            {
              userId: 'user-1',
              itemId: 'master-v3',
              isStarred: false,
              readStatus: 'unread',
            },
          ],
          itemMetadata: [
            {
              id: 'meta-master-1',
              itemId: 'master-v3',
              sourceProvider: 'crossref',
              rawPayload: { v: 1 },
            },
          ],
        },
        duplicates: [
          {
            id: 'dup-v3',
            title: 'Duplicate With Rich Relations',
            contributors: [
              { fullName: 'Grace Hopper', creatorType: 'author', orderIndex: 0 },
            ],
            itemRelations: [
              {
                id: 'rel-dup-1',
                sourceItemId: 'dup-v3',
                targetItemId: 'other-2',
                relationType: 'supplement',
              },
            ],
            userPublications: [
              { userId: 'user-2', itemId: 'dup-v3', isPublic: false },
            ],
            userStates: [
              {
                userId: 'user-1',
                itemId: 'dup-v3',
                isStarred: true,
                rating: 5,
                readStatus: 'read',
              },
            ],
            itemMetadata: [
              {
                id: 'meta-dup-1',
                itemId: 'dup-v3',
                sourceProvider: 'openalex',
                rawPayload: { isOffloaded: true, fileId: 'retained-blob-1' },
              },
            ],
          },
        ],
        uniqueDupIds: ['dup-v3'],
      });
      const latestSerialized = serializeMergeMemento(latestMemento);

      const mockTx = {
        duplicateMergeAudit: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({
              id: 'audit-latest',
              masterItemId: 'master-v3',
              snapshotJson: latestSerialized,
            })
            .mockResolvedValueOnce({
              id: 'audit-older',
              masterItemId: 'master-v3',
              snapshotJson: olderSerialized,
            }),
          delete: jest.fn().mockResolvedValue({ id: 'audit-latest' }),
        },
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'master-v3',
            metadata: { lastMergeMemento: latestSerialized },
          }),
          update: jest.fn().mockImplementation((args) =>
            Promise.resolve({ id: args.where.id, ...args.data, version: 3 }),
          ),
        },
        itemIdentifier: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          upsert: jest.fn().mockResolvedValue({}),
        },
        contributor: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        itemRelation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        userPublication: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        state: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        itemMetadata: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const mockHelpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        recordTombstone: jest.fn().mockResolvedValue(undefined),
      };

      const mergerService = new DuplicateMergerService({
        executeInTransaction: jest
          .fn()
          .mockImplementation((fn) => fn(mockTx, mockHelpers)),
      } as never);

      const undoRes = await mergerService.undoMerge('user-1', 'master-v3');
      expect(undoRes.restoredPrimaryId).toBe('master-v3');
      expect(undoRes.restoredDuplicateIds).toEqual(['dup-v3']);

      // Verifies audit stack pop and restoration of previous memento into master metadata
      expect(mockTx.duplicateMergeAudit.delete).toHaveBeenCalledWith({
        where: { id: 'audit-latest' },
      });
      const masterUpdateArgs = mockTx.item.update.mock.calls[0][0];
      expect(masterUpdateArgs.data.metadata.lastMergeMemento).toEqual(
        olderSerialized,
      );

      // Verifies overwritten master identifier upsert and duplicate relation restoration
      expect(mockTx.itemIdentifier.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { itemId_type: { itemId: 'master-v3', type: 'doi' } },
          update: {
            value: '10.1000/master-original',
            canonicalUri: '10.1000/master-original',
          },
        }),
      );
      expect(mockTx.contributor.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            itemId: 'dup-v3',
            fullName: 'Grace Hopper',
          }),
        ],
      });
      expect(mockTx.itemRelation.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              id: 'rel-dup-1',
              sourceItemId: 'dup-v3',
              targetItemId: 'other-2',
            }),
          ],
        }),
      );
      expect(mockTx.userPublication.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              userId: 'user-2',
              itemId: 'dup-v3',
            }),
          ],
        }),
      );
      expect(mockTx.state.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              userId: 'user-1',
              itemId: 'dup-v3',
              isStarred: true,
              rating: 5,
            }),
          ],
        }),
      );
      expect(mockTx.itemMetadata.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              id: 'meta-dup-1',
              itemId: 'dup-v3',
              sourceProvider: 'openalex',
            }),
          ],
        }),
      );
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
      await new MetadataAndCreatorBackfillMergeStep().execute({
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

    it('BE-META3 & BE-META4: soft-deletes duplicate attachments on merge, removes tombstones on undoMerge, and restores soft-deleted attachments', async () => {
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

      // S3 fileId must NOT be returned as orphaned for immediate deletion while merge is undoable
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

      // Verify undoMerge calls removeTombstone and un-soft-deletes duplicate attachments
      const memento = createDuplicateMergeMemento({
        primary: {
          id: 'master-1',
          title: 'Master Title',
          contributors: [{ fullName: 'Yann LeCun', orderIndex: 0 }],
        },
        duplicates: [
          {
            id: 'dup-1',
            title: 'Dup Title',
            attachmentIds: ['att-dup'],
            contributors: [{ fullName: 'Yoshua Bengio', orderIndex: 0 }],
          },
        ],
        uniqueDupIds: ['dup-1'],
      });
      const serialized = serializeMergeMemento(memento);

      const mockUndoTx = {
        duplicateMergeAudit: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'audit-1',
            masterItemId: 'master-1',
            snapshotJson: serialized,
          }),
          delete: jest.fn().mockResolvedValue({}),
        },
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'master-1',
            metadata: { lastMergeMemento: serialized },
          }),
          update: jest.fn().mockImplementation((args) =>
            Promise.resolve({ id: args.where.id, ...args.data, version: 2 }),
          ),
        },
        attachment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        contributor: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const mockUndoHelpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        recordTombstone: jest.fn().mockResolvedValue(undefined),
        removeTombstone: jest.fn().mockResolvedValue(undefined),
      };

      const mergerService = new DuplicateMergerService({
        executeInTransaction: jest
          .fn()
          .mockImplementation((fn) => fn(mockUndoTx, mockUndoHelpers)),
      } as never);

      await mergerService.undoMerge('user-1', 'master-1');

      expect(mockUndoHelpers.removeTombstone).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        'Item',
        'dup-1',
      );
      expect(mockUndoTx.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['att-dup'] }, deletedAt: { not: null } },
        data: { itemId: 'dup-1', deletedAt: null },
      });
      // Verify CDC snapshot includes restored contributors via ItemsMapper.toDomain
      const dupChangeCall = mockUndoHelpers.appendChange.mock.calls.find(
        (c) => c[1]?.entityId === 'dup-1',
      );
      expect(dupChangeCall?.[1]?.data?.authors).toContain('Yoshua Bengio');
    });

    it('BE-META5: unifies ReconciliationPolicy with FieldReconciliationStrategies, aligns conflicting publicationDate/year, and additively enriches Extra', () => {
      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([
        {
          sourceProvider: 'arxiv',
          retrievedAt: '2026-10-26T00:00:00.000Z',
          overallConfidence: 0.9,
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
          sourceProvider: 'crossref',
          retrievedAt: '2026-10-26T00:00:00.000Z',
          overallConfidence: 0.98,
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
    it('BE-SYS-META1: captures all multi-provider ItemMetadata rows, deletes migrated 0->1 UserPublication/ItemMetadata on undo, and restores attachmentType/counts', async () => {
      const { ItemMetadataConsolidationMergeStep } = await import(
        '@/modules/library/ingestion/domain/duplicate-merge.steps'
      );
      const {
        attachCapturedMergeStepRelations,
        createDuplicateMergeMemento,
        executeUndoDuplicateMergeInTx,
      } = await import(
        '@/modules/library/ingestion/domain/duplicate-merge.memento'
      );

      const step = new ItemMetadataConsolidationMergeStep();
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
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const stepCtx = {
        tx: mockTxMeta as never,
        primary: { id: 'primary-1' },
        duplicates: [{ id: 'dup-1' }],
        uniqueDupIds: ['dup-1'],
        offloadedFileIdsToDelete: [] as string[],
        capturedPrimaryItemMetadata: undefined as Array<Record<string, unknown>> | undefined,
        capturedDuplicateItemMetadata: undefined as Array<Record<string, unknown>> | undefined,
      };
      await step.execute(stepCtx as never);
      expect(stepCtx.capturedPrimaryItemMetadata).toHaveLength(2);

      // Test 0-row primary relations + attachmentType/counts restoration on undoMerge
      const primaryRelations = {
        attachmentIds: ['att-master-1'],
        attachments: [{ id: 'att-master-1', attachmentType: 'primary_pdf' }],
      };
      const duplicateRelationsById = {
        'dup-1': {
          attachmentIds: ['att-dup-1'],
          attachments: [{ id: 'att-dup-1', attachmentType: 'primary_pdf' }],
        },
      };
      attachCapturedMergeStepRelations({
        primaryId: 'primary-1',
        duplicates: [{ id: 'dup-1' }],
        primaryRelations,
        duplicateRelationsById,
        preMergePubs: {
          primaryPublications: [],
          dupPublications: [{ userId: 'u-1', itemId: 'dup-1', isPublic: true }],
        },
        capturedPrimaryItemMetadata: [],
        capturedDuplicateItemMetadata: [
          { id: 'meta-dup-only', itemId: 'dup-1', sourceProvider: 'crossref', rawPayload: {} },
        ],
      });

      expect(primaryRelations).toEqual(
        expect.objectContaining({
          userPublications: [],
          itemMetadata: [],
        }),
      );

      const memento = createDuplicateMergeMemento({
        primary: { id: 'primary-1', title: 'Master', hasFile: true, attachmentCount: 1 },
        duplicates: [{ id: 'dup-1', title: 'Dup', hasFile: true, attachmentCount: 1 }],
        uniqueDupIds: ['dup-1'],
        primaryRelations,
        duplicateRelationsById,
      });

      const undoTx = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'primary-1',
            metadata: { lastMergeMemento: memento },
          }),
          update: jest.fn().mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
            id: args.where.id,
            version: 2,
            ...args.data,
          })),
        },
        userPublication: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        itemMetadata: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        attachment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      const helpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        removeTombstone: jest.fn().mockResolvedValue(undefined),
      };

      await executeUndoDuplicateMergeInTx({
        tx: undoTx as never,
        helpers: helpers as never,
        userId: 'u-1',
        primaryItemId: 'primary-1',
      });

      // Migrated UserPublication and ItemMetadata on 0-row master are cleaned up
      expect(undoTx.userPublication.deleteMany).toHaveBeenCalledWith({
        where: { itemId: 'primary-1' },
      });
      expect(undoTx.itemMetadata.deleteMany).toHaveBeenCalledWith({
        where: { itemId: 'primary-1' },
      });
      // Demoted duplicate attachmentType is restored to 'primary_pdf' and counts are restored
      expect(undoTx.attachment.update).toHaveBeenCalledWith({
        where: { id: 'att-dup-1' },
        data: { itemId: 'dup-1', deletedAt: null, attachmentType: 'primary_pdf' },
      });
      expect(undoTx.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dup-1' },
          data: expect.objectContaining({
            hasFile: true,
            attachmentCount: 1,
          }),
        }),
      );
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
      const { ReconciliationPolicy } = await import(
        '@/modules/library/ingestion/policies/reconciliation.policy'
      );
      const { TrustedExtractionService } = await import(
        '@/modules/library/extraction/services/trusted-extraction.service'
      );
      const tierChainMod = await import(
        '@/modules/library/extraction/domain/pdf-extraction-tier.chain'
      );

      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([
        {
          candidateId: 'c-1',
          sourceKind: 'PROVIDER',
          sourceName: 'EnrichedProvider',
          sourceProvider: 'crossref',
          retrievedAt: '2026-10-26T00:00:00.000Z',
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
