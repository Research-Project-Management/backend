import { CommitStage, toItemData } from '@/modules/library/ingestion/stages/commit.stage';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { PipelineBatchExecutor } from '@/modules/library/ingestion/services/pipeline-batch.executor';
import { PipelineSideEffectsService } from '@/modules/library/ingestion/services/pipeline-side-effects.service';
import {
  buildEnrichmentPatch,
  sanitizeOverrides,
} from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import { MetadataResolverService } from '@/modules/library/ingestion/services/metadata-resolver.service';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { ExtractionMetadataSynchronizer } from '@/modules/library/extraction/services/extraction-metadata.synchronizer';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';

describe('Horizontal Frond 1 — Async Pipeline, Batch Executor, Extraction Synchronizer & Retraction Interleaving', () => {
  describe('Fix 1: CommitStage vs PipelineSideEffectsService.attachFile Short-Circuit', () => {
    it('does not leak metadata.fileId into CreateItemData unless options.fileId is explicitly passed, and attachFile ignores 0-byte bare placeholders', async () => {
      const converted = toItemData({
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        fileId: 'staged-pdf-file-123',
        filename: 'attention.pdf',
      });

      expect(converted.fileId).toBeUndefined();
      expect((converted.extraFields as Record<string, unknown>)?.fileId).toBeUndefined();

      const explicitConverted = toItemData(
        {
          title: 'Attention Is All You Need',
          itemType: 'journalArticle',
        },
        { fileId: 'explicit-file-456', filename: 'explicit.pdf' },
      );
      expect(explicitConverted.fileId).toBe('explicit-file-456');

      const mockCatalogGateway = {
        getPrimaryCreatorType: jest.fn().mockReturnValue('author'),
        createItem: jest.fn().mockImplementation(async (_uId: string, data: Record<string, unknown>) => ({
          id: 'item-created-1',
          ...data,
          attachments: data.fileId
            ? [{ id: 'bare-att-1', fileId: data.fileId, size: 0 }]
            : [],
        })),
      };
      const mockExtractionGateway = {
        createAttachment: jest.fn().mockResolvedValue({ id: 'full-att-1' }),
      };

      const commitStage = new CommitStage(mockCatalogGateway as never);
      const sideEffects = new PipelineSideEffectsService(
        {} as never,
        mockCatalogGateway as never,
        mockExtractionGateway as never,
      );

      const proposedItem = {
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        year: 2017,
        authors: ['Ashish Vaswani'],
        fileId: 'staged-pdf-file-123',
        filename: 'attention.pdf',
      };

      const createdItem = await commitStage.execute({
        scopeId: 'user-1',
        item: proposedItem,
        options: {
          userId: 'user-1',
          source: 'PDF_UPLOAD',
          filename: 'attention.pdf',
          skipPreMatch: true,
        },
      });

      await sideEffects.attachFile(
        'user-1',
        undefined,
        createdItem.id,
        'staged-pdf-file-123',
        'attention.pdf',
        524288,
        {
          ...proposedItem,
          ...(createdItem as unknown as Record<string, unknown>),
        },
      );

      expect(mockExtractionGateway.createAttachment).toHaveBeenCalledTimes(1);
      expect(mockExtractionGateway.createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          itemId: 'item-created-1',
          fileId: 'staged-pdf-file-123',
          filename: 'Vaswani - 2017 - Attention Is All You Need.pdf',
          size: 524288,
        }),
        undefined,
      );
    });
  });

  describe('Fix 2: PipelineBatchExecutor & EnrichStage Parity, Cross-Candidate Isolation & Control Override Filtering', () => {
    it('enriches a single/small-batch RECORD candidate that has a DOI/arXivId when missing abstract or venue', async () => {
      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          canonicalId: 'doi:10.1038/s41586-021-03819-2',
          resolvedAt: new Date().toISOString(),
          metadata: {
            title: 'Highly accurate protein structure prediction with AlphaFold',
            authors: ['John Jumper', 'Demis Hassabis'],
            year: 2021,
            journal: 'Nature',
            publicationTitle: 'Nature',
            doi: '10.1038/s41586-021-03819-2',
            abstract:
              'Proteins are essential to life, and understanding their structure can facilitate a mechanistic understanding of their function.',
          },
          provenance: {
            abstract: { provider: 'CrossRef', confidence: 0.98 },
            journal: { provider: 'CrossRef', confidence: 0.98 },
          },
        }),
      };

      const enrichStage = new EnrichStage(mockMetadataService as never);
      const partialBibRecord: MetadataCandidate = {
        candidateId: 'rec-partial-1',
        sourceKind: 'RECORD',
        sourceName: 'BibTeX',
        confidenceScore: 0.9,
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        fields: {},
        normalizedMetadata: {
          title: 'Highly accurate protein structure prediction with AlphaFold',
          authors: ['John Jumper', 'Demis Hassabis'],
          year: 2021,
          doi: '10.1038/s41586-021-03819-2',
        },
      };

      const enriched = await enrichStage.execute({
        candidates: [partialBibRecord],
        scopeId: 'user-1',
      });

      expect(mockMetadataService.resolve).toHaveBeenCalledTimes(1);
      expect(enriched).toHaveLength(2);
      expect(enriched[1].sourceKind).toBe('PROVIDER');
      expect(enriched[1].normalizedMetadata.abstract).toContain('Proteins are essential');
    });

    it('prevents cross-candidate contamination by title and preserves distinct identifier-less records with same title', async () => {
      const repoMock = {
        findRunById: jest.fn().mockResolvedValue(null),
        updateRunProgress: jest.fn().mockResolvedValue(undefined),
        updateRunStatus: jest.fn().mockResolvedValue(undefined),
        createReviewCase: jest.fn().mockResolvedValue(undefined),
      };
      const reconcileMock = {
        execute: jest.fn().mockImplementation(async (cands: MetadataCandidate[]) => {
          const provider = cands.find((c) => c.sourceKind === 'PROVIDER');
          const base = cands[0];
          return {
            proposedItem: {
              ...base.normalizedMetadata,
              ...(provider ? provider.normalizedMetadata : {}),
            },
          };
        }),
      };
      const matchMock = {
        execute: jest.fn().mockResolvedValue({ matchType: 'NONE' }),
      };
      let counter = 0;
      const commitMock = {
        execute: jest.fn().mockImplementation(async ({ item }) => ({
          id: `committed-${++counter}`,
          ...item,
        })),
      };
      const sideEffectsMock = {
        scanRetraction: jest.fn().mockResolvedValue(undefined),
        materializeNotes: jest.fn().mockResolvedValue(undefined),
        assignItemToCollection: jest.fn().mockResolvedValue(undefined),
      };

      const executor = new PipelineBatchExecutor(
        repoMock as never,
        reconcileMock as never,
        matchMock as never,
        commitMock as never,
        sideEffectsMock as never,
      );

      const cand1: MetadataCandidate = {
        candidateId: 'cand-1',
        sourceKind: 'RECORD',
        sourceName: 'BibTeX',
        confidenceScore: 0.85,
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        fields: {},
        normalizedMetadata: {
          title: 'Deep Learning',
          authors: ['Yann LeCun'],
          year: 2015,
        },
      };
      const cand2: MetadataCandidate = {
        candidateId: 'cand-2',
        sourceKind: 'RECORD',
        sourceName: 'BibTeX',
        confidenceScore: 0.85,
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        fields: {},
        normalizedMetadata: {
          title: 'Deep Learning',
          authors: ['Ian Goodfellow'],
          year: 2016,
        },
      };
      const providerForCand1: MetadataCandidate = {
        candidateId: 'prov-1',
        sourceKind: 'PROVIDER',
        sourceName: 'EnrichedProvider',
        rawEvidenceRef: 'cand-1',
        confidenceScore: 0.98,
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        fields: {},
        normalizedMetadata: {
          title: 'Deep Learning',
          authors: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'],
          year: 2015,
          doi: '10.1038/nature14539',
          publicationTitle: 'Nature',
        },
      };

      const aggregateMock = {
        recordProgress: jest.fn(),
        complete: jest.fn(),
      };
      const sessionMock = {
        executeStep: jest.fn().mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn()),
      };

      await executor.processRecordBatch({
        scopeId: 'user-1',
        runId: 'run-batch-1',
        envelope: {
          idempotencyKey: 'idem-1',
          scope: { userId: 'user-1' },
          payload: { kind: 'BIBTEX', content: '' },
        } as never,
        resolvedScope: { userId: 'user-1' },
        aggregate: aggregateMock as never,
        session: sessionMock as never,
        normalizedCandidates: [cand1, cand2],
        enrichedCandidates: [cand1, cand2, providerForCand1],
      });

      expect(commitMock.execute).toHaveBeenCalledTimes(2);
      const reconcileSecondCallCands = reconcileMock.execute.mock.calls[1][0] as MetadataCandidate[];
      expect(reconcileSecondCallCands).toHaveLength(1);
      expect(reconcileSecondCallCands[0].candidateId).toBe('cand-2');
    });

    it('strips attachOaPdf and saveSnapshot control flags in sanitizeOverrides', () => {
      const cleaned = sanitizeOverrides({
        title: 'Custom User Title',
        attachOaPdf: true,
        saveSnapshot: false,
        id: 'system-id',
      });
      expect(cleaned).toEqual({ title: 'Custom User Title' });
      expect(cleaned.attachOaPdf).toBeUndefined();
      expect(cleaned.saveSnapshot).toBeUndefined();
    });
  });

  describe('Fix 3: ExtractionMetadataSynchronizer, ExtractionRepository & Citation Trap Rollback', () => {
    it('upgrades filename-derived title and clears isFilenameTitle in both ExtractionMetadataSynchronizer and ExtractionRepository without preserving stale provenance', async () => {
      const synchronizer = new ExtractionMetadataSynchronizer({} as never);
      const plan = synchronizer.buildMetadataSyncPlan(
        {
          id: 'att-1',
          itemId: 'item-1',
          item: {
            id: 'item-1',
            userId: 'user-1',
            projectId: null,
            title: '2501.12948v1',
            itemType: 'journalArticle',
            publicationTitle: 'Nature',
            doi: null,
            abstract: null,
            year: 2025,
            citationKey: 'anon2025',
            metadata: {
              title: '2501.12948v1',
              isFilenameTitle: true,
              publicationTitle: 'Nature',
              engineUsed: 'CrossRef',
              fieldProvenance: {
                title: {
                  source: 'StagedPdf',
                  confidence: 0.35,
                  isFilenameTitle: true,
                },
              },
            },
            contributors: [],
            itemTags: [],
          },
        },
        {
          fullText: 'Full text of paper',
          pageCount: 12,
          metadata: {
            title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs',
            arxivId: '2501.12948',
          },
          references: [],
        } as never,
      );

      expect(plan.itemPatch.title).toBe(
        'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs',
      );
      expect(plan.metaPatch.title).toBe(
        'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs',
      );
      expect(plan.metaPatch.isFilenameTitle).toBe(false);
      // Should NOT downgrade journalArticle with Nature publicationTitle to preprint
      expect(plan.metaPatch.itemType).toBeUndefined();
      const syncedProv = plan.metaPatch.fieldProvenance as Record<
        string,
        Record<string, unknown>
      >;
      expect(syncedProv.title).toEqual(
        expect.objectContaining({
          source: 'LocalPDFExtraction',
          isFilenameTitle: false,
        }),
      );

      const mockTx = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'item-1',
            userId: 'user-1',
            projectId: null,
            title: '2501.12948v1',
            itemType: 'journalArticle',
            publicationTitle: 'Nature',
            doi: null,
            abstract: null,
            year: 2025,
            citationKey: 'anon2025',
            metadata: {
              title: '2501.12948v1',
              isFilenameTitle: true,
              publicationTitle: 'Nature',
              engineUsed: 'CrossRef',
              fieldProvenance: {
                title: {
                  source: 'StagedPdf',
                  confidence: 0.35,
                  isFilenameTitle: true,
                },
              },
            },
          }),
          update: jest.fn().mockImplementation(async ({ data }) => data),
        },
      };

      const extractionRepo = new ExtractionRepository(mockTx as never);
      const updatedData = (await extractionRepo.updateItemWithExtractedMetadata(
        'item-1',
        {
          title: plan.itemPatch.title as string,
          metadata: plan.metaPatch as never,
        },
        mockTx as never,
      )) as unknown as Record<string, unknown>;

      expect(updatedData.title).toBe(
        'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs',
      );
      const persistedMeta = updatedData.metadata as Record<string, unknown>;
      expect(persistedMeta.title).toBe(
        'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs',
      );
      expect(persistedMeta.isFilenameTitle).toBe(false);
      const persistedProv = persistedMeta.fieldProvenance as Record<
        string,
        Record<string, unknown>
      >;
      expect(persistedProv.title.source).toBe('LocalPDFExtraction');
      expect(persistedProv.title.isFilenameTitle).toBe(false);
    });

    it('clears contaminated arxivId, pmid, and isbn in addition to doi when Page-1 Citation Trap triggers', async () => {
      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          canonicalId: 'arxiv:1706.03762',
          resolvedAt: new Date().toISOString(),
          metadata: {
            title: 'Attention Is All You Need',
            arxivId: '1706.03762',
          },
        }),
      };
      const mockCatalogGateway = {
        getItem: jest.fn().mockResolvedValue({
          id: 'item-trap-1',
          version: 2,
          title: 'Novel Quantum Error Correction Codes on Toric Lattices',
          doi: null,
          arxivId: '1706.03762',
          pmid: '99887766',
          extraFields: {
            arxivId: '1706.03762',
            pmid: '99887766',
          },
        }),
        updateItem: jest.fn().mockResolvedValue({ id: 'item-trap-1' }),
      };

      const resolver = new MetadataResolverService(
        mockCatalogGateway as never,
        mockMetadataService as never,
      );

      const res = await resolver.reconcileExtractedCandidate({
        userId: 'user-1',
        itemId: 'item-trap-1',
        extractedMetadata: {
          title: 'Novel Quantum Error Correction Codes on Toric Lattices',
          arxivId: '1706.03762',
          pmid: '99887766',
        },
      });

      expect(res.updated).toBe(false);
      expect(mockCatalogGateway.updateItem).toHaveBeenCalledWith(
        'user-1',
        'item-trap-1',
        expect.objectContaining({
          arxivId: null,
          pmid: null,
          extraFields: expect.objectContaining({
            arxivId: null,
            pmid: null,
            rejectedCitedDoi: '1706.03762',
          }),
        }),
        expect.anything(),
      );
    });
  });

  describe('Fix 4: buildEnrichmentPatch Authority Baseline, Secondary Contributors & Coupled Provenance', () => {
    it('protects un-tagged existing fields from unverified 0.85 candidates while preserving secondary contributors and coupled provenance', () => {
      const existingItem = {
        id: 'item-curated-1',
        itemType: 'book',
        title: 'Curated Book Title',
        publicationTitle: 'Original Series',
        creators: [
          {
            creatorType: 'author',
            firstName: 'old',
            lastName: 'Author',
            fullName: 'old Author',
          },
          {
            creatorType: 'editor',
            firstName: 'Ada',
            lastName: 'Lovelace',
            fullName: 'Ada Lovelace',
          },
          {
            creatorType: 'translator',
            firstName: 'Alan',
            lastName: 'Turing',
            fullName: 'Alan Turing',
          },
        ],
        metadata: {},
      };

      // 1. Unverified candidate with no sourceProvider (0.85) cannot overwrite existing title when fallbackEngine is undefined (0.85)
      const unverifiedPatch = buildEnrichmentPatch(existingItem, {
        itemType: 'book',
        title: 'Noisy Unverified Title',
      });
      expect(unverifiedPatch.title).toBeUndefined();

      // 2. High-authority CrossRef candidate upgrades low-authority StagedPdf creators while preserving editor + translator, and stamps coupled provenance
      const stagedItem = {
        ...existingItem,
        metadata: {
          engineUsed: 'StagedPdf',
        },
      };
      const authoritativePatch = buildEnrichmentPatch(stagedItem, {
        itemType: 'book',
        sourceProvider: 'CrossRef',
        journal: 'Authoritative Journal Alias',
        creators: [
          {
            creatorType: 'author',
            firstName: 'Grace',
            lastName: 'Hopper',
            fullName: 'Grace Hopper',
          },
        ],
        isRetracted: true,
        citationCount: 120,
        referenceCount: 45,
        extraFields: {
          fieldProvenance: {
            journal: {
              source: 'CrossRef',
              sourceProvider: 'CrossRef',
              confidence: 0.98,
            },
          },
        },
      });

      const patchedCreators = authoritativePatch.creators as Array<{
        creatorType: string;
        fullName: string;
      }>;
      expect(patchedCreators).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ creatorType: 'author', fullName: 'Grace Hopper' }),
          expect.objectContaining({ creatorType: 'editor', fullName: 'Ada Lovelace' }),
          expect.objectContaining({ creatorType: 'translator', fullName: 'Alan Turing' }),
        ]),
      );
      expect(authoritativePatch.isRetracted).toBe(true);
      expect(authoritativePatch.citationCount).toBe(120);
      expect(authoritativePatch.referenceCount).toBe(45);

      const patchedProv = (
        authoritativePatch.extraFields as {
          fieldProvenance?: Record<string, { sourceProvider?: string }>;
        }
      )?.fieldProvenance;
      expect(patchedProv?.publicationTitle?.sourceProvider).toBe('CrossRef');
      expect(patchedProv?.journal?.sourceProvider).toBe('CrossRef');
    });
  });

  describe('Fix 5: RetractionRepository.updateItemRetraction Atomic Read & No Spurious Version Bump', () => {
    it('reads item metadata inside the transaction and avoids bumping version or emitting changelog on clean scan when status is unchanged', async () => {
      const txFindUnique = jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        projectId: null,
        metadata: {
          concurrentField: 'preserved-from-tx',
          isRetracted: false,
        },
      });
      const txUpdate = jest.fn().mockImplementation(async ({ data }) => ({
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        projectId: null,
        version: data.version ? 2 : 1,
        metadata: data.metadata,
      }));
      const helpersMock = {
        appendChange: jest.fn().mockResolvedValue(BigInt(1)),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
      };
      const libraryTxMock = {
        executeInTransaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown, helpers: unknown) => Promise<unknown>) =>
            fn({ item: { findUnique: txFindUnique, update: txUpdate } }, helpersMock),
          ),
      };
      const outerPrismaMock = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111',
            userId: 'user-1',
            projectId: null,
            metadata: { staleField: true },
          }),
        },
      };

      const repo = new RetractionRepository(
        outerPrismaMock as never,
        libraryTxMock as never,
      );

      // 1. Clean scan (isRetracted = false, unchanged)
      await repo.updateItemRetraction(
        '11111111-1111-4111-8111-111111111111',
        false,
        null,
        null,
      );

      expect(txFindUnique).toHaveBeenCalledTimes(1);
      expect(outerPrismaMock.item.findUnique).not.toHaveBeenCalled();
      const firstUpdateData = txUpdate.mock.calls[0][0].data;
      expect(firstUpdateData.version).toBeUndefined();
      expect(firstUpdateData.metadata.concurrentField).toBe('preserved-from-tx');
      expect(helpersMock.appendChange).not.toHaveBeenCalled();
      expect(helpersMock.publishOutbox).not.toHaveBeenCalled();

      // 2. Retracted scan (isRetracted = true, statusChanged = true)
      await repo.updateItemRetraction(
        '11111111-1111-4111-8111-111111111111',
        true,
        'retraction',
        { reason: 'Data fabrication' } as never,
      );

      const secondUpdateData = txUpdate.mock.calls[1][0].data;
      expect(secondUpdateData.version).toEqual({ increment: 1 });
      expect(helpersMock.appendChange).toHaveBeenCalledTimes(1);
      expect(helpersMock.publishOutbox).toHaveBeenCalledTimes(1);
    });
  });
});
