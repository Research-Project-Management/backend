import { BadRequestException } from '@nestjs/common';
import { IngestionStatus, Prisma } from '@prisma/client';
import { buildEvidenceFields } from '@/modules/library/ingestion/stages/candidate-builder.helper';
import { PipelineService } from '@/modules/library/ingestion/services/pipeline.service';
import { QueueService } from '@/modules/library/ingestion/services/queue.service';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import {
  selectAuthoritativeCreatorVariant,
  countFullGivenNames,
  AppendOnlyUniqueArrayReconciliationStrategy,
  ScalarTrustHierarchyReconciliationStrategy,
  WeightedFieldVariant,
} from '@/modules/library/ingestion/domain/field-reconciliation.strategies';
import {
  finalizeReconciledBibliographicMetadata,
  MetadataReconciliationService,
} from '@/modules/library/ingestion/services/metadata-reconciliation.service';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import {
  collectExactIdentifierClusters,
  collectFuzzyTitleYearAuthorClusters,
  RawDuplicateCluster,
} from '@/modules/library/ingestion/domain/duplicate-clustering.helper';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { MatchStage } from '@/modules/library/ingestion/stages/match.stage';
import { DuplicatePolicy } from '@/modules/library/ingestion/policies/duplicate.policy';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import {
  capturePreMergeRelationsInTx,
  restoreMasterRelationsInTx,
  restoreDuplicateRelationsInTx,
} from '@/modules/library/ingestion/domain/duplicate-merge-relations.memento';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { MetadataService } from '@/modules/library/ingestion/services/metadata.service';
import { MetadataExecutorService } from '@/modules/library/ingestion/services/metadata-executor.service';

describe('Loop 2 Worker 4 — Ingestion, Reconciliation, Deduplication & Merge Optimizations', () => {
  describe('Group 1: Pipeline Claim-Check Cleanup, Retryable Status & Candidate Builder', () => {
    it('buildEvidenceFields falls back to normalizedMetadata when rawMetadata is undefined for synthesized fields', () => {
      const rawMetadata = { title: 'Raw Title' };
      const normalizedMetadata = {
        title: 'Normalized Title',
        publicationDate: '2025-04-01',
        year: 2025,
      };

      const evidence = buildEvidenceFields(
        rawMetadata,
        normalizedMetadata,
        'BibTeX',
        0.95,
      );

      expect(evidence.title.value).toBe('Raw Title');
      expect(evidence.publicationDate.value).toBe('2025-04-01');
      expect(evidence.year.value).toBe(2025);
    });

    it('PipelineService preserves offloaded S3 claim-check blob on retryable failure and deletes on final or non-retryable failure', async () => {
      const deleteFile = jest.fn().mockResolvedValue(undefined);
      const updateRunStatus = jest.fn().mockResolvedValue(undefined);

      const repoMock = {
        findRunById: jest.fn().mockResolvedValue(null),
        updateRunStage: jest.fn().mockResolvedValue(undefined),
        createStage: jest.fn().mockResolvedValue(undefined),
        updateRunStatus,
        purgeOldRuns: jest.fn().mockResolvedValue(0),
      };

      const identifyMock = {
        execute: jest
          .fn()
          .mockRejectedValueOnce(new Error('ETIMEDOUT upstream network timeout'))
          .mockRejectedValueOnce(
            new BadRequestException(
              'No valid bibliographic metadata could be identified',
            ),
          ),
      };

      const pipeline = new PipelineService(
        repoMock as never,
        identifyMock as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { deleteFile } as never,
      );

      const offloadedEnvelope = {
        userId: 'user-1',
        payload: {
          kind: 'RECORD' as const,
          format: 'BIBTEX' as const,
          isOffloaded: true,
          fileId: 'claim-check-file-123',
        },
      };

      // 1. Retryable error -> should NOT delete offloaded claim-check file
      await expect(
        pipeline.executePipeline('run-retry-1', 'user-1', offloadedEnvelope),
      ).rejects.toThrow('ETIMEDOUT');
      expect(deleteFile).not.toHaveBeenCalled();
      expect(updateRunStatus).toHaveBeenLastCalledWith(
        'user-1',
        'run-retry-1',
        IngestionStatus.FAILED_RETRYABLE,
        expect.objectContaining({
          lastError: expect.stringContaining('ETIMEDOUT'),
        }),
      );

      // 2. Non-retryable BadRequestException even when isFinalAttempt=false -> MUST delete offloaded file & mark FAILED_FINAL
      await expect(
        pipeline.executePipeline('run-final-2', 'user-1', offloadedEnvelope, {
          isFinalAttempt: false,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(deleteFile).toHaveBeenCalledWith('claim-check-file-123');
      expect(updateRunStatus).toHaveBeenLastCalledWith(
        'user-1',
        'run-final-2',
        IngestionStatus.FAILED_FINAL,
        expect.objectContaining({
          lastError: expect.stringContaining(
            'No valid bibliographic metadata',
          ),
        }),
      );
    });

    it('QueueService and IngestionService classify transient errors as FAILED_RETRYABLE and validation errors as FAILED_FINAL', async () => {
      const repoMock = {
        updateRunStatus: jest.fn().mockResolvedValue(undefined),
        findOrphanedRuns: jest.fn().mockResolvedValue([]),
        findRunById: jest.fn().mockResolvedValue({
          id: 'run-q-1',
          status: IngestionStatus.FAILED_RETRYABLE,
        }),
      };

      const pipelineMock = {
        isNonRetryableError: PipelineService.prototype.isNonRetryableError,
        isRetryableError: PipelineService.prototype.isRetryableError,
        executePipeline: jest
          .fn()
          .mockRejectedValueOnce(new Error('503 Service Unavailable'))
          .mockRejectedValueOnce(
            new BadRequestException('Invalid payload format'),
          ),
      };

      const queueService = new QueueService(
        pipelineMock as never,
        repoMock as never,
      );

      await (
        queueService as unknown as {
          executeJob: (job: Record<string, unknown>) => Promise<void>;
        }
      ).executeJob({
        runId: 'run-q-1',
        projectId: 'proj-1',
        envelope: {
          userId: 'user-1',
          payload: { kind: 'IDENTIFIER', value: '10.1000/1' },
        },
      });

      expect(repoMock.updateRunStatus).toHaveBeenLastCalledWith(
        'proj-1',
        'run-q-1',
        IngestionStatus.FAILED_RETRYABLE,
        expect.objectContaining({
          lastError: '503 Service Unavailable',
        }),
      );

      await (
        queueService as unknown as {
          executeJob: (job: Record<string, unknown>) => Promise<void>;
        }
      ).executeJob({
        runId: 'run-q-2',
        projectId: 'proj-1',
        envelope: {
          userId: 'user-1',
          payload: { kind: 'IDENTIFIER', value: 'bad' },
        },
      });

      expect(repoMock.updateRunStatus).toHaveBeenLastCalledWith(
        'proj-1',
        'run-q-2',
        IngestionStatus.FAILED_FINAL,
        expect.objectContaining({
          lastError: 'Invalid payload format',
        }),
      );

      // Verify IngestionService.isRetryableIngestionError
      const ingestionSvc = Object.create(
        IngestionService.prototype,
      ) as IngestionService;
      (ingestionSvc as unknown as { pipeline: unknown }).pipeline =
        pipelineMock;
      const classifyFn = (
        ingestionSvc as unknown as {
          isRetryableIngestionError: (err: unknown) => boolean;
        }
      ).isRetryableIngestionError.bind(ingestionSvc);

      expect(classifyFn(new Error('Redis ECONNRESET'))).toBe(true);
      expect(classifyFn(new BadRequestException('Bad input'))).toBe(false);
    });
  });

  describe('Group 2: Field Reconciliation Strategies, Author Completeness & Provider Provenance', () => {
    it('selectAuthoritativeCreatorVariant and finalizeReconciledBibliographicMetadata prefer full given names over initials and never overwrite longer authors with shorter creators', () => {
      const variants = [
        {
          sourceProvider: 'crossref',
          val: [
            { firstName: 'J.', lastName: 'Smith', fullName: 'J. Smith' },
            { firstName: 'A.', lastName: 'Doe', fullName: 'A. Doe' },
          ],
        },
        {
          sourceProvider: 'pubmed',
          val: [
            {
              firstName: 'Johnathan',
              lastName: 'Smith',
              fullName: 'Johnathan Smith',
            },
            {
              firstName: 'Alice',
              lastName: 'Doe',
              fullName: 'Alice Doe',
            },
          ],
        },
      ];

      expect(countFullGivenNames(variants[0].val)).toBe(0);
      expect(countFullGivenNames(variants[1].val)).toBe(2);

      const selected = selectAuthoritativeCreatorVariant(variants);
      expect(selected.sourceProvider).toBe('pubmed');

      // Verify finalizeReconciledBibliographicMetadata does NOT overwrite 3 authors with 1 creator
      const resolvedRecord: Record<string, unknown> = {
        title: 'Multi-Author Study',
        itemType: 'journalArticle',
        authors: ['Johnathan Smith', 'Alice Doe', 'Robert Brown'],
        creators: [
          {
            creatorType: 'author',
            firstName: 'J.',
            lastName: 'Smith',
            fullName: 'J. Smith',
          },
        ],
      };

      finalizeReconciledBibliographicMetadata(resolvedRecord);
      expect(resolvedRecord.authors).toEqual([
        'Johnathan Smith',
        'Alice Doe',
        'Robert Brown',
      ]);
      expect((resolvedRecord.creators as unknown[]).length).toBe(3);
    });

    it('ScalarTrustHierarchyReconciliationStrategy filters boilerplate abstracts and upgrades <60 char snippets to complete authoritative abstracts', () => {
      const strategy = new ScalarTrustHierarchyReconciliationStrategy();
      const longAbstract =
        'We introduce a novel transformer architecture for long-horizon scientific reasoning across multimodal molecular graphs, achieving state-of-the-art accuracy on 14 benchmarks with linear memory scaling.';

      // 1. Boilerplate filtering ("N/A", "Abstract not available.")
      const boilerplateVariants: WeightedFieldVariant[] = [
        {
          candidate: {
            id: 'c1',
            sourceProvider: 'CrossRef',
            confidenceScore: 0.95,
            metadata: {} as never,
            fetchedAt: new Date().toISOString(),
          },
          val: 'Abstract not available.',
          effectiveWeight: 0.95,
        },
        {
          candidate: {
            id: 'c2',
            sourceProvider: 'OpenAlex',
            confidenceScore: 0.85,
            metadata: {} as never,
            fetchedAt: new Date().toISOString(),
          },
          val: longAbstract,
          effectiveWeight: 0.8,
        },
      ];

      const outcome1 = strategy.reconcileField('abstract', boilerplateVariants);
      expect(outcome1.value).toBe(longAbstract);
      expect(outcome1.assertion.sourceProvider).toBe('OpenAlex');

      // 2. Short snippet (< 60 chars) upgraded to >=150 char authoritative abstract
      const snippetVariants: WeightedFieldVariant[] = [
        {
          candidate: {
            id: 'c1',
            sourceProvider: 'CrossRef',
            confidenceScore: 0.95,
            metadata: {} as never,
            fetchedAt: new Date().toISOString(),
          },
          val: 'Short teaser snippet only.',
          effectiveWeight: 0.95,
        },
        {
          candidate: {
            id: 'c2',
            sourceProvider: 'PubMed',
            confidenceScore: 0.9,
            metadata: {} as never,
            fetchedAt: new Date().toISOString(),
          },
          val: longAbstract,
          effectiveWeight: 0.85,
        },
      ];

      const outcome2 = strategy.reconcileField('abstract', snippetVariants);
      expect(outcome2.value).toBe(longAbstract);
      expect(outcome2.assertion.sourceProvider).toBe('PubMed');
    });

    it('AppendOnlyUniqueArrayReconciliationStrategy respects isUserOverride without appending provider tags', () => {
      const strategy = new AppendOnlyUniqueArrayReconciliationStrategy();
      const variants: WeightedFieldVariant[] = [
        {
          candidate: {
            id: 'u1',
            sourceProvider: 'UserOverride',
            confidenceScore: 1.0,
            metadata: {} as never,
            fetchedAt: new Date().toISOString(),
          },
          val: ['curated-tag'],
          effectiveWeight: 10.0,
          isUserOverride: true,
        },
        {
          candidate: {
            id: 'p1',
            sourceProvider: 'OpenAlex',
            confidenceScore: 0.9,
            metadata: {} as never,
            fetchedAt: new Date().toISOString(),
          },
          val: ['noisy-auto-tag-1', 'noisy-auto-tag-2'],
          effectiveWeight: 0.8,
        },
      ];

      const outcome = strategy.reconcileField('tags', variants);
      expect(outcome.value).toEqual(['curated-tag']);
      expect(outcome.assertion.isUserOverride).toBe(true);
    });

    it('EnrichStage and ReconciliationPolicy preserve upstream provider identity (CrossRef, PubMed) in FieldEvidence and fieldProvenance', async () => {
      const metadataPortMock = {
        resolve: jest.fn().mockResolvedValue({
          canonicalId: '10.1038/s41586-021-03819-2',
          resolvedAt: '2026-03-01T00:00:00.000Z',
          metadata: {
            title: 'Highly accurate protein structure prediction with AlphaFold',
            doi: '10.1038/s41586-021-03819-2',
            pmid: '34265844',
          },
          provenance: {
            title: {
              source: 'CrossRef',
              confidence: 0.98,
              fetchedAt: '2026-03-01T00:00:00.000Z',
            },
            pmid: {
              provider: 'PubMed',
              confidence: 0.99,
              fetchedAt: '2026-03-01T00:00:00.000Z',
            },
          },
        }),
      };

      const enrichStage = new EnrichStage(
        metadataPortMock as never,
        new NormalizationPolicy(),
      );

      const enriched = await enrichStage.execute({
        scopeId: 'user-1',
        candidates: [
          {
            candidateId: 'cand-1',
            sourceKind: 'IDENTIFIER',
            sourceName: 'DOI',
            retrievedAt: '2026-03-01T00:00:00.000Z',
            schemaVersion: '1.0.0',
            fields: {},
            normalizedMetadata: {
              doi: '10.1038/s41586-021-03819-2',
            },
            confidenceScore: 0.9,
          },
        ],
      });

      const providerCand = enriched.find((c) => c.sourceKind === 'PROVIDER')!;
      expect(providerCand).toBeDefined();
      expect(providerCand.fields.title.sourceProvider).toBe('CrossRef');
      expect(providerCand.fields.pmid.sourceProvider).toBe('PubMed');

      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile(enriched);
      expect(decision.selectedFields.title.sourceProvider).toBe('CrossRef');
      expect(decision.selectedFields.pmid.sourceProvider).toBe('PubMed');
      const fieldProv = (
        decision.proposedItem.extraFields as Record<string, unknown>
      ).fieldProvenance as Record<string, { source: string; sourceProvider: string }>;
      expect(fieldProv.title.source).toBe('CrossRef');
      expect(fieldProv.pmid.sourceProvider).toBe('PubMed');
    });
  });

  describe('Group 3: Deduplication Transitive Dismissal, Conflicting arXiv Guard & MatchStage Candidate Sorting', () => {
    it('collectFuzzyTitleYearAuthorClusters checks all existing cluster members so dismissed or conflicting pairs cannot chain transitively', () => {
      const items = [
        {
          id: 'item-a',
          title: 'Deep Reinforcement Learning for Robotic Manipulation',
          year: 2024,
          authors: ['Sergey Levine'],
          metadata: {},
        },
        {
          id: 'item-b',
          title: 'Deep Reinforcement Learning for Robotic Manipulation',
          year: 2024,
          authors: ['Sergey Levine'],
          metadata: {},
        },
        {
          id: 'item-c',
          title: 'Deep Reinforcement Learning for Robotic Manipulation',
          year: 2024,
          authors: ['Sergey Levine'],
          metadata: {},
        },
      ];

      const rawClusters: RawDuplicateCluster[] = [];
      // Dismiss pair (item-b, item-c): item-c must NOT join [item-a, item-b]!
      collectFuzzyTitleYearAuthorClusters({
        items: items as never,
        groupedItemIds: new Set<string>(),
        rawClusters,
        isDismissedPair: (x, y) =>
          (x.id === 'item-b' && y.id === 'item-c') ||
          (x.id === 'item-c' && y.id === 'item-b'),
        hasConflictingTier2BibliographicEvidence: () => false,
        computeRecommendedMasterId: (grp) => grp[0].id,
      });

      expect(rawClusters).toHaveLength(1);
      expect(rawClusters[0].rawGroup.map((i) => i.id)).toEqual([
        'item-a',
        'item-b',
      ]);
    });

    it('DuplicateDetectorService.hasConflictingTier2BibliographicEvidence flags distinct arXiv IDs as conflicting while permitting preprint-to-published evolution', () => {
      const detector = new DuplicateDetectorService({} as never);

      // Two distinct arXiv preprints with different arXiv IDs -> CONFLICT (true)
      const hasConflictDistinctArxiv =
        detector.hasConflictingTier2BibliographicEvidence(
          {
            id: 'a1',
            title: 'Scaling Laws for Language Models',
            itemType: 'preprint',
            arxivId: '2401.00001v1',
            metadata: {},
          } as never,
          {
            id: 'a2',
            title: 'Scaling Laws for Language Models',
            itemType: 'preprint',
            arxivId: '2401.99999v1',
            metadata: {},
          } as never,
        );
      expect(hasConflictDistinctArxiv).toBe(true);

      // Same base arXiv ID across v1 and v2 -> NO CONFLICT (false)
      const hasConflictSameArxivVersion =
        detector.hasConflictingTier2BibliographicEvidence(
          {
            id: 'a1',
            title: 'Scaling Laws for Language Models',
            itemType: 'preprint',
            arxivId: '2401.00001v1',
            metadata: {},
          } as never,
          {
            id: 'a2',
            title: 'Scaling Laws for Language Models',
            itemType: 'preprint',
            arxivId: '2401.00001v3',
            metadata: {},
          } as never,
        );
      expect(hasConflictSameArxivVersion).toBe(false);

      // Preprint (arXiv DOI) evolving into published journal article (Nature DOI) -> NO CONFLICT (false)
      const hasConflictPreprintEvolution =
        detector.hasConflictingTier2BibliographicEvidence(
          {
            id: 'pre-1',
            title: 'Scaling Laws for Language Models',
            itemType: 'preprint',
            doi: '10.48550/arXiv.2401.00001',
            arxivId: '2401.00001',
            metadata: {},
          } as never,
          {
            id: 'pub-1',
            title: 'Scaling Laws for Language Models',
            itemType: 'journalArticle',
            doi: '10.1038/s41586-024-00001-1',
            metadata: {},
          } as never,
        );
      expect(hasConflictPreprintEvolution).toBe(false);
    });

    it('MatchStage sorts candidateItems descending by title similarity before evaluating DuplicatePolicy', async () => {
      const catalogGatewayMock = {
        findMatchCandidates: jest.fn().mockResolvedValue({
          exactMatch: null,
          candidateItems: [
            {
              id: 'cand-lower-sim',
              title: 'Deep Learning for Medical Imaging in Radiology Survey',
              year: 2024,
              authors: ['Jane Smith'],
            },
            {
              id: 'cand-exact-title-sim',
              title: 'Deep Learning for Medical Imaging in Radiology',
              year: 2024,
              authors: ['Jane Smith'],
            },
          ],
        }),
      };

      const matchStage = new MatchStage(
        new DuplicatePolicy(),
        catalogGatewayMock as never,
      );

      const decision = await matchStage.execute({
        scope: 'user-1',
        proposedItem: {
          title: 'Deep Learning for Medical Imaging in Radiology',
          year: 2024,
          authors: ['Jane Smith'],
        },
      });

      expect(decision.matchType).toBe('PROBABLE');
      expect(decision.targetItemId).toBe('cand-exact-title-sim');
    });
  });

  describe('Group 4: Annotations Comment Preservation, Undo Merge Restoration, UserState Rating, Metadata Cache & Circuit Breaker', () => {
    it('AttachmentsRepository.reassignToItem preserves duplicate annotations on the same quote when comment differs', async () => {
      const deletedIds: string[] = [];
      const movedIds: string[] = [];

      const mockTx = {
        attachment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'att-master',
              itemId: 'item-master',
              fileHash: 'sha256-same-pdf',
              deletedAt: null,
            },
            {
              id: 'att-dup',
              itemId: 'item-dup',
              fileHash: 'sha256-same-pdf',
              deletedAt: null,
            },
          ]),
          update: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(1),
        },
        annotation: {
          findMany: jest
            .fn()
            .mockImplementation(async ({ where }: { where: { attachmentId: string } }) => {
              if (where.attachmentId === 'att-master') {
                return [
                  {
                    id: 'ann-master-1',
                    pageIndex: 2,
                    type: 'highlight',
                    quoteText: 'Transformer self-attention mechanism',
                    comment: 'Initial reading note',
                  },
                ];
              }
              return [
                // Identical quote AND identical comment -> should be deleted
                {
                  id: 'ann-dup-identical',
                  pageIndex: 2,
                  type: 'highlight',
                  quoteText: 'Transformer self-attention mechanism',
                  comment: 'Initial reading note',
                },
                // Identical quote but DIFFERENT non-empty comment -> MUST be preserved and moved!
                {
                  id: 'ann-dup-distinct-comment',
                  pageIndex: 2,
                  type: 'highlight',
                  quoteText: 'Transformer self-attention mechanism',
                  comment: 'Crucial ablation result for Section 4!',
                },
              ];
            }),
          deleteMany: jest.fn().mockImplementation(async ({ where }) => {
            deletedIds.push(...where.id.in);
            return { count: where.id.in.length };
          }),
          updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
            if (data?.deletedAt) {
              deletedIds.push(...where.id.in);
            } else {
              movedIds.push(...where.id.in);
            }
            return { count: where.id.in.length };
          }),
        },
        item: {
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const repo = new AttachmentsRepository({} as never);
      await repo.reassignToItem(['item-dup'], 'item-master', mockTx as never);

      expect(deletedIds).toEqual(['ann-dup-identical']);
      expect(movedIds).toEqual(['ann-dup-distinct-comment']);
    });

    it('capturePreMergeRelationsInTx and restoreDuplicateRelationsInTx capture and restore annotations and sync attachment counts', async () => {
      const updatedAnnotations: Array<{ id: string; data: Record<string, unknown> }> = [];
      const updatedItems: Array<{ where: unknown; data: Record<string, unknown> }> = [];

      const mockTx = {
        attachment: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'att-m', itemId: 'master-1', attachmentType: 'pdf' },
            { id: 'att-d', itemId: 'dup-1', attachmentType: 'supplement' },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(1),
        },
        annotation: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'ann-d-1', attachmentId: 'att-d', deletedAt: null },
          ]),
          update: jest.fn().mockImplementation(async ({ where, data }) => {
            updatedAnnotations.push({ id: where.id, data });
            return {};
          }),
        },
        item: {
          updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
            updatedItems.push({ where, data });
            return { count: 1 };
          }),
        },
      };

      const captured = await capturePreMergeRelationsInTx({
        tx: mockTx as unknown as Prisma.TransactionClient,
        primary: { id: 'master-1' },
        duplicates: [{ id: 'dup-1' }],
        uniqueDupIds: ['dup-1'],
      });

      expect(captured.duplicateRelationsById['dup-1'].annotations).toEqual([
        { id: 'ann-d-1', attachmentId: 'att-d', deletedAt: null },
      ]);

      await restoreDuplicateRelationsInTx(
        mockTx as unknown as Prisma.TransactionClient,
        'master-1',
        'dup-1',
        {
          id: 'dup-1',
          attachmentIds: ['att-d'],
          attachments: captured.duplicateRelationsById['dup-1'].attachments,
        },
      );

      expect(updatedAnnotations).toEqual([
        {
          id: 'ann-d-1',
          data: { attachmentId: 'att-d', deletedAt: null },
        },
      ]);
      expect(updatedItems).toEqual([
        {
          where: { id: 'dup-1' },
          data: { hasFile: true, attachmentCount: 1 },
        },
      ]);
    });

    it('StateService.transferUserItemStates preserves null rating when unrated and preserves skimmed status above unread', async () => {
      const upserted = new Map<string, Record<string, unknown>>();
      const mockTx = {
        state: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: 'user-unrated',
              itemId: 'item-1',
              isStarred: false,
              rating: null,
              readStatus: 'unread',
              currentPage: 1,
              scrollPosition: null,
              lastOpenedAt: null,
              lastReadAt: null,
            },
            {
              userId: 'user-unrated',
              itemId: 'item-2',
              isStarred: false,
              rating: null,
              readStatus: 'skimmed',
              currentPage: 3,
              scrollPosition: null,
              lastOpenedAt: null,
              lastReadAt: null,
            },
          ]),
          upsert: jest.fn().mockImplementation(async ({ where, create }) => {
            upserted.set(where.userId_itemId.userId, create);
            return create;
          }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const stateService = new StateService({} as never, {} as never);
      await stateService.transferUserItemStates(
        mockTx as unknown as Prisma.TransactionClient,
        ['item-2'],
        'item-1',
      );

      expect(upserted.get('user-unrated')).toEqual(
        expect.objectContaining({
          rating: null,
          readStatus: 'skimmed',
          currentPage: 3,
        }),
      );
    });

    it('MetadataService.resolve bypasses cache when includeCitations or includeReferences is requested but missing from cached entry', async () => {
      const cacheMock = {
        available: true,
        buildKey: jest.fn().mockReturnValue('meta:doi:10.1000/test'),
        get: jest.fn().mockResolvedValue({
          canonicalId: '10.1000/test',
          metadata: {
            title: 'Cached Title Without References',
            doi: '10.1000/test',
          },
          provenance: {},
          resolvedAt: '2026-01-01T00:00:00.000Z',
        }),
        set: jest.fn().mockResolvedValue(undefined),
      };

      const executorMock = {
        execute: jest.fn().mockResolvedValue({
          provider: 'CrossRef',
          status: 'found',
          durationMs: 12,
          result: {
            provider: 'CrossRef',
            canonicalId: '10.1000/test',
            confidence: 0.95,
            fetchedAt: '2026-03-01T00:00:00.000Z',
            metadata: {
              title: 'Fresh Title With References',
              authors: ['Jane Smith'],
              year: 2026,
              doi: '10.1000/test',
              references: [{ doi: '10.1000/ref1' }],
            },
          },
        }),
      };

      const providerMock = {
        id: 'CrossRef',
        supports: jest.fn().mockReturnValue(true),
      };

      const metadataService = new MetadataService(
        [providerMock as never],
        cacheMock as never,
        new MetadataReconciliationService(),
        executorMock as never,
      );

      const res = await metadataService.resolve({
        query: '10.1000/test',
        includeReferences: true,
      } as never);

      expect(executorMock.execute).toHaveBeenCalled();
      expect(res?.cached).toBe(false);
    });

    it('MetadataExecutorService does not record circuit-breaker failure on 404 Not Found or 400/422 Bad Request', async () => {
      const executor = new MetadataExecutorService();

      const notFoundProvider = {
        id: 'CrossRef',
        capabilities: { timeoutMs: 5000, maxConcurrency: 2, supportsSearch: true },
        supports: () => true,
        resolve: jest.fn().mockRejectedValue(
          Object.assign(new Error('HTTP 404 Not Found'), { statusCode: 404 }),
        ),
      };

      const badRequestProvider = {
        id: 'PubMed',
        capabilities: { timeoutMs: 5000, maxConcurrency: 2, supportsSearch: true },
        supports: () => true,
        resolve: jest.fn().mockRejectedValue(
          Object.assign(new Error('400 Bad Request: invalid identifier'), {
            statusCode: 400,
          }),
        ),
      };

      const res404 = await executor.execute(notFoundProvider as never, {
        query: '10.1000/nonexistent',
        queryType: 'DOI' as never,
      });
      expect(res404.status).toBe('not_found');

      const res400 = await executor.execute(badRequestProvider as never, {
        query: 'invalid-pmid',
        queryType: 'PMID' as never,
      });
      expect(res400.status).toBe('invalid_payload');
    });
  });
});
