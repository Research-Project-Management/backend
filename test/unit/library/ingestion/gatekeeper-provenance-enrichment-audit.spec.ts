import {
  ItemProvenancePolicy,
  COUPLED_METADATA_ALIASES,
  isPlaceholderItemTitle,
  hasAuthorAndYearCorroboration,
} from '@/modules/library/core';
import {
  buildEnrichmentPatch,
  buildReResolvePatch,
} from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import { MetadataResolverService } from '@/modules/library/ingestion/services/metadata-resolver.service';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { ReconcileStage } from '@/modules/library/ingestion/stages/reconcile.stage';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { ExtractionMetadataSynchronizer } from '@/modules/library/extraction/services/extraction-metadata.synchronizer';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';

describe('Gatekeeper Auditor G1 — Provenance, Locks, Authority, Enrichment & PDF Extraction Guards', () => {
  describe('Fix 1A, 1B, 1C, 1D: ItemProvenancePolicy & AcademicTitleDomain', () => {
    it('Fix 1A: couples year <-> date <-> publicationDate symmetrically and recognizes manual/lockedByUser provenance', () => {
      expect(COUPLED_METADATA_ALIASES.year).toEqual(
        expect.arrayContaining(['date', 'publicationDate']),
      );
      expect(COUPLED_METADATA_ALIASES.date).toEqual(
        expect.arrayContaining(['publicationDate', 'year']),
      );
      expect(COUPLED_METADATA_ALIASES.publicationDate).toEqual(
        expect.arrayContaining(['date', 'year']),
      );

      const itemWithManualSource = {
        metadata: {
          fieldProvenance: {
            date: { source: 'manual', confidence: 1.0 },
            publisher: { source: 'Reconcile', lockedByUser: true },
          },
        },
      };

      expect(ItemProvenancePolicy.isFieldLocked(itemWithManualSource, 'year')).toBe(true);
      expect(ItemProvenancePolicy.isFieldLocked(itemWithManualSource, 'publicationDate')).toBe(
        true,
      );
      expect(ItemProvenancePolicy.isFieldLocked(itemWithManualSource, 'publisher')).toBe(true);
    });

    it('Fix 1B: applyManualEditLocks skips unchanged fields in full-item updates and unlocks cleared fields (and coupled aliases)', () => {
      const existingMeta: Record<string, unknown> = {
        title: 'Unchanged Paper Title',
        year: 2024,
        abstract: 'Bad OCR Abstract To Clear',
        abstractNote: 'Bad OCR Abstract To Clear',
        lockedFields: ['abstract', 'abstractNote'],
        fieldProvenance: {
          title: { source: 'CrossRef', confidence: 0.98 },
          year: { source: 'CrossRef', confidence: 0.98 },
          abstract: { source: 'UserOverride', isUserOverride: true, confidence: 1.0 },
          abstractNote: { source: 'UserOverride', isUserOverride: true, confidence: 1.0 },
        },
      };

      const updatedMetadata: Record<string, unknown> = {
        ...existingMeta,
        publisher: 'MIT Press',
        abstract: null,
        abstractNote: null,
      };

      ItemProvenancePolicy.applyManualEditLocks({
        existingMeta,
        dataRecord: {
          title: 'Unchanged Paper Title', // unchanged -> must NOT become locked!
          year: 2024, // unchanged -> must NOT become locked!
          publisher: 'MIT Press', // changed -> MUST become locked!
          abstract: '', // cleared by user -> MUST unlock abstract + abstractNote!
        },
        updatedMetadata,
      });

      const lockedFields = (updatedMetadata.lockedFields as string[]) || [];
      expect(lockedFields).toContain('publisher');
      expect(lockedFields).not.toContain('title');
      expect(lockedFields).not.toContain('year');
      expect(lockedFields).not.toContain('abstract');
      expect(lockedFields).not.toContain('abstractNote');
      expect(ItemProvenancePolicy.isFieldLocked(updatedMetadata, 'abstract')).toBe(false);
    });

    it('Fix 1C: canOverwriteField allows filling empty fields even if stale lock exists, and filterAiMetadataPatch rejects placeholder titles', () => {
      const itemWithEmptyLockedField = {
        metadata: {
          abstract: '',
          lockedFields: ['abstract'],
        },
      };
      expect(
        ItemProvenancePolicy.canOverwriteField(
          itemWithEmptyLockedField,
          'abstract',
          'CrossRef',
          { hasNonEmptyExisting: false },
        ),
      ).toBe(true);
      expect(
        ItemProvenancePolicy.canOverwriteField(
          itemWithEmptyLockedField,
          'abstract',
          'CrossRef',
        ),
      ).toBe(true);

      const { filteredPatch } = ItemProvenancePolicy.filterAiMetadataPatch(
        {},
        {
          title: 'Original Article',
          abstract: 'Valid AI extracted abstract text.',
        },
      );
      expect(filteredPatch.title).toBeUndefined();
      expect(filteredPatch.abstract).toBe('Valid AI extracted abstract text.');
    });

    it('Fix 1D: isPlaceholderItemTitle detects journal section headers and publisher banners without false-positiving real titles', () => {
      expect(isPlaceholderItemTitle('Original Article')).toBe(true);
      expect(isPlaceholderItemTitle('Research Article')).toBe(true);
      expect(isPlaceholderItemTitle('Review Article')).toBe(true);
      expect(isPlaceholderItemTitle('Short Communication')).toBe(true);
      expect(isPlaceholderItemTitle('Accepted Manuscript')).toBe(true);
      expect(isPlaceholderItemTitle('Contents lists available at ScienceDirect')).toBe(true);
      expect(isPlaceholderItemTitle('Downloaded from https://academic.oup.com/brain')).toBe(
        true,
      );

      expect(isPlaceholderItemTitle('A Review Article on Quantum Error Correction')).toBe(false);
      expect(isPlaceholderItemTitle('Original Article Classification with BERT')).toBe(false);
    });
  });

  describe('Fix 2A, 2B, 2C: buildEnrichmentPatch & buildReResolvePatch Authority & Tag Union', () => {
    it('Fix 2A & 2B: buildEnrichmentPatch allows CrossRef to upgrade un-provenanced and BibTeX fields and unions new keywords case-insensitively', () => {
      const unpItem = {
        id: 'item-unp-1',
        itemType: 'journalArticle',
        title: 'Slightly Typoed Local Title',
        publicationTitle: 'Proc. Conf.',
        keywords: ['Deep Learning', 'Transformers'],
        metadata: {},
      };

      const patch = buildEnrichmentPatch(unpItem, {
        itemType: 'journalArticle',
        sourceProvider: 'CrossRef',
        title: 'Authoritative CrossRef Title',
        publicationTitle: 'Nature Machine Intelligence',
        keywords: ['transformers', 'Reinforcement Learning', 'Reasoning'],
      });

      expect(patch.title).toBe('Authoritative CrossRef Title');
      expect(patch.publicationTitle).toBe('Nature Machine Intelligence');
      expect(patch.keywords).toEqual([
        'Deep Learning',
        'Transformers',
        'Reinforcement Learning',
        'Reasoning',
      ]);

      // BibTeX (0.91 * 0.9 = 0.819) upgraded by CrossRef (0.98 * 0.9 = 0.882)
      const bibtexItem = {
        id: 'item-bib-1',
        itemType: 'journalArticle',
        title: 'BibTeX Draft Title',
        metadata: {
          sourceProvider: 'BibTeX',
          fieldProvenance: {
            title: { source: 'BibTeX', confidence: 0.9 },
          },
        },
      };
      const bibUpgradePatch = buildEnrichmentPatch(bibtexItem, {
        itemType: 'journalArticle',
        sourceProvider: 'CrossRef',
        title: 'Canonical CrossRef Title',
      });
      expect(bibUpgradePatch.title).toBe('Canonical CrossRef Title');
    });

    it('Fix 2C: buildReResolvePatch prevents downgrading CrossRef journal to arXiv or lower-authority provider unless explicitly requested in options.fields', () => {
      const existingPublishedItem = {
        id: 'item-pub-1',
        itemType: 'journalArticle',
        title: 'Attention Is All You Need',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        volume: '30',
        metadata: {
          fieldProvenance: {
            publicationTitle: { source: 'CrossRef', confidence: 0.98 },
            volume: { source: 'CrossRef', confidence: 0.95 },
          },
        },
      };

      const arxivReResolve = buildReResolvePatch(existingPublishedItem, {
        itemType: 'journalArticle',
        sourceProvider: 'arXiv',
        title: 'Attention Is All You Need',
        publicationTitle: 'arXiv',
        abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      });

      expect(arxivReResolve.updateData.publicationTitle).toBeUndefined();
      expect(arxivReResolve.updateData.abstract).toContain('dominant sequence transduction');
    });
  });

  describe('Fix 3A, 3B, 3C, 3D: MetadataResolverService, EnrichStage, ReconcileStage & ReconciliationPolicy', () => {
    it('Fix 3A: reResolveMetadata requires titleSimilarity >= 0.75 for TITLE queries and allows repairing corrupted PDF authors when titleSimilarity >= 0.92 and year matches', async () => {
      const mockCatalog = {
        getItem: jest.fn().mockResolvedValue({
          id: 'item-corrupt-authors',
          userId: 'user-1',
          version: 1,
          title: 'Attention Is All You Need',
          year: 2017,
          creators: [{ firstName: 'Department', lastName: 'ComputerScience' }],
          extraFields: {},
          metadata: {},
        }),
        updateItem: jest.fn().mockImplementation(async (_u, _id, data) => ({
          id: 'item-corrupt-authors',
          ...data,
        })),
      };

      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          query: 'Attention Is All You Need',
          queryType: 'TITLE',
          canonicalId: '10.5555/3295222.3295349',
          metadata: {
            title: 'Attention Is All You Need',
            year: 2017,
            authors: ['Ashish Vaswani', 'Noam Shazeer'],
            publicationTitle: 'NeurIPS',
          },
        }),
      };

      const resolver = new MetadataResolverService(
        mockCatalog as never,
        mockMetadataService as never,
      );

      const res = await resolver.reResolveMetadata('user-1', 'item-corrupt-authors');
      expect(res.success).toBe(true);
      expect(res.updatedFields).toContain('creators');
    });

    it('Fix 3B: Page-1 Citation Trap is bypassed when author surname + publication year corroborate the DOI in both MetadataResolverService and ReconcileStage', async () => {
      expect(
        hasAuthorAndYearCorroboration(
          { authors: ['Ashish Vaswani'], year: 2017 },
          { creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }], year: 2017 },
        ),
      ).toBe(true);

      const mockCatalog = {
        getItem: jest.fn().mockResolvedValue({
          id: 'item-corroborated',
          userId: 'user-1',
          version: 1,
          title: 'Special Issue Banner — NeurIPS Proceedings Header',
          year: 2017,
          creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }],
          extraFields: {},
          metadata: {},
        }),
        updateItem: jest.fn().mockResolvedValue({ id: 'item-corroborated', version: 2 }),
      };

      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          query: '10.5555/3295222.3295349',
          queryType: 'DOI',
          canonicalId: 'doi:10.5555/3295222.3295349',
          metadata: {
            title: 'Attention Is All You Need',
            doi: '10.5555/3295222.3295349',
            year: 2017,
            authors: ['Ashish Vaswani', 'Noam Shazeer'],
          },
        }),
      };

      const resolver = new MetadataResolverService(
        mockCatalog as never,
        mockMetadataService as never,
      );

      const res = await resolver.reconcileExtractedCandidate({
        userId: 'user-1',
        itemId: 'item-corroborated',
        extractedMetadata: {
          title: 'Special Issue Banner — NeurIPS Proceedings Header',
          doi: '10.5555/3295222.3295349',
          authors: ['Ashish Vaswani'],
          year: 2017,
        },
      });

      expect(res.updated).toBe(true);
      expect(res.rejectedCitedDoi).toBeUndefined();

      // ReconcileStage also preserves external candidate when corroborated by author + year
      const reconcileStage = new ReconcileStage(new ReconciliationPolicy());
      const decision = await reconcileStage.execute([
        {
          candidateId: 'file-1',
          sourceKind: 'FILE',
          sourceName: 'TrustedPaper',
          confidenceScore: 0.85,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          fields: {},
          normalizedMetadata: {
            title: 'Special Issue Banner — NeurIPS Proceedings Header',
            doi: '10.5555/3295222.3295349',
            authors: ['Ashish Vaswani'],
            year: 2017,
          },
        },
        {
          candidateId: 'prov-1',
          sourceKind: 'PROVIDER',
          sourceName: 'CrossRef',
          confidenceScore: 0.98,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            doi: '10.5555/3295222.3295349',
            authors: ['Ashish Vaswani', 'Noam Shazeer'],
            year: 2017,
          },
        },
      ]);

      expect(decision.proposedItem.title).toBe('Attention Is All You Need');
      expect(decision.proposedItem.doi).toBe('10.5555/3295222.3295349');
    });

    it('Fix 3C & 3D: EnrichStage matches truncated PDF author lists and Vietnamese đ, and ReconciliationPolicy applies field-specific weights to EnrichedProvider', async () => {
      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          queryType: 'TITLE',
          canonicalId: '10.1000/vn-paper',
          resolvedAt: new Date().toISOString(),
          metadata: {
            title: 'Vietnamese NLP Transformer Architecture',
            authors: [
              'Nguyen Van Đạt',
              'Tran Minh',
              'Le Hoang',
              'Pham Tuan',
              'Vo Thanh',
              'Bui Quang',
            ],
            year: 2025,
          },
        }),
      };

      const enrichStage = new EnrichStage(mockMetadataService as never);
      const enriched = await enrichStage.execute({
        scopeId: 'user-1',
        candidates: [
          {
            candidateId: 'pdf-vn-1',
            sourceKind: 'FILE',
            sourceName: 'StagedPdf',
            confidenceScore: 0.7,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {},
            normalizedMetadata: {
              title: 'Vietnamese NLP Transformer Architecture',
              authors: ['Nguyen Van Dat'], // 1 out of 6 authors, ASCII 'd' vs 'Đ'
            },
          },
        ],
      });

      expect(enriched).toHaveLength(2);

      // ReconciliationPolicy field-specific priority: TrustedPaper abstract (0.93) beats EnrichedProvider CrossRef abstract (0.70)
      const policy = new ReconciliationPolicy();
      const reconciled = policy.reconcile([
        {
          candidateId: 'file-abs',
          sourceKind: 'FILE',
          sourceName: 'TrustedPaper',
          confidenceScore: 0.9,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          normalizedMetadata: {
            title: 'Paper Title',
            abstract: 'Clean PDF Extracted Abstract without JATS artifacts.',
          },
          fields: {
            abstract: {
              path: 'abstract',
              value: 'Clean PDF Extracted Abstract without JATS artifacts.',
              normalizedValue: 'Clean PDF Extracted Abstract without JATS artifacts.',
              confidence: 0.92,
              sourceProvider: 'TrustedPaper',
              retrievedAt: new Date().toISOString(),
            },
          },
        },
        {
          candidateId: 'prov-abs',
          sourceKind: 'PROVIDER',
          sourceName: 'EnrichedProvider',
          confidenceScore: 0.95,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          normalizedMetadata: {
            title: 'Paper Title',
            abstract: 'Truncated CrossRef snippet.',
          },
          fields: {
            abstract: {
              path: 'abstract',
              value: 'Truncated CrossRef snippet.',
              normalizedValue: 'Truncated CrossRef snippet.',
              confidence: 0.9,
              sourceProvider: 'CrossRef',
              retrievedAt: new Date().toISOString(),
            },
          },
        },
      ]);

      expect(reconciled.proposedItem.abstract).toBe(
        'Clean PDF Extracted Abstract without JATS artifacts.',
      );
    });
  });

  describe('Fix 4A & 4B: ExtractionMetadataSynchronizer Tag Union & ExtractionRepository Column-Alias Guard', () => {
    it('Fix 4A & 4B: unions extracted keywords when tagCount < 15 and prevents incomingMeta aliases from overwriting populated freshItem columns', async () => {
      const syncItemTagsMock = jest.fn().mockResolvedValue(['quantum', 'entanglement']);
      const mockRepo = {
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({}),
        countContributors: jest.fn().mockResolvedValue(2),
        countItemTags: jest.fn().mockResolvedValue(3), // non-zero (< 15)
        syncItemTags: syncItemTagsMock,
        countItemNotes: jest.fn().mockResolvedValue(0),
        updateItem: jest.fn().mockResolvedValue({ id: 'item-sync-1', version: 2 }),
      };

      const synchronizer = new ExtractionMetadataSynchronizer(mockRepo as never);
      await synchronizer.offloadFullTextAndSyncMetadata(
        {
          id: 'att-sync-1',
          itemId: 'item-sync-1',
          item: {
            id: 'item-sync-1',
            userId: 'user-1',
            title: 'Quantum Entanglement',
            metadata: {},
          },
        },
        {
          fullText: 'Sample PDF text',
          metadata: {
            keywords: ['quantum', 'entanglement'],
          },
        },
        { text: 'Sample PDF text' },
      );

      expect(syncItemTagsMock).toHaveBeenCalledTimes(1);

      // Fix 4B: ExtractionRepository guards freshItem.abstract, freshItem.year, freshItem.publicationTitle against incomingMeta aliases
      const mockPrisma = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'item-col-guard',
            userId: 'user-1',
            projectId: null,
            citationKey: 'vaswani2017attention',
            title: 'Attention Is All You Need',
            doi: '10.5555/3295222.3295349',
            abstract: 'Authoritative Registry Abstract',
            year: 2017,
            publicationTitle: 'NeurIPS',
            itemType: 'journalArticle',
            metadata: {
              // Note: abstractNote, date, journal are not yet duplicated in metadata JSON
            },
          }),
          update: jest.fn().mockImplementation(async ({ data }) => data),
        },
      };

      const extractionRepo = new ExtractionRepository(mockPrisma as never);
      const updated = (await extractionRepo.updateItemWithExtractedMetadata(
        'item-col-guard',
        {
          metadata: {
            abstractNote: 'Noisy PDF Abstract Should Be Blocked',
            date: '2016',
            publicationDate: '2016',
            journal: 'Noisy PDF Header Banner',
            pages: '5998-6008',
          },
        },
      )) as unknown as { metadata: Record<string, unknown> };

      expect(updated.metadata.abstractNote).toBeUndefined();
      expect(updated.metadata.date).toBeUndefined();
      expect(updated.metadata.publicationDate).toBeUndefined();
      expect(updated.metadata.journal).toBeUndefined();
      expect(updated.metadata.pages).toBe('5998-6008');
    });
  });
});
