import zlib from 'zlib';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IngestionStatus } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { PipelineService } from '@/modules/library/ingestion/services/pipeline.service';
import { MetadataResolverService } from '@/modules/library/ingestion/services/metadata-resolver.service';
import {
  IngestionVerifierService,
  PdfFingerprint,
} from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { IngestionSagaOrchestrator } from '@/modules/library/ingestion/services/ingestion-saga.service';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.domain';
import { NormalizationPolicy } from '@/modules/library/ingestion/domain/normalization.policy';
import { applyUserOverridesToCandidate } from '@/modules/library/ingestion/domain/metadata-validation.policy';
import {
  buildEnrichmentPatch,
  buildReResolvePatch,
} from '@/modules/library/ingestion/domain/enrichment-patch.mapper';
import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { IdentifyFileResolver } from '@/modules/library/ingestion/stages/identify-file.resolver';
import {
  ResolveStage,
  evaluateCandidateEnrichmentReadiness,
} from '@/modules/library/ingestion/stages/resolve.stage';
import { toItemData } from '@/modules/library/ingestion/stages/commit.stage';
import {
  BibtexParser,
  DoiParser,
} from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { IFilesPort } from '@/modules/files/types/files.type';
import { ICatalogFacade, ItemDetail } from '@/modules/library/core';
import {
  MetadataCandidate,
  MetadataPort,
  ResolvedMetadata,
} from '@/modules/library/ingestion/types/metadata.types';

describe('Library Ingestion Pipeline — Claim Check, CAS PDF Cache, Verifier, Re-Resolve & Saga', () => {
  describe('Claim Check Offload & IdentifyFileResolver SHA-256 CAS Cache', () => {
    it('keeps <=32KB records inline, offloads >32KB records via gzip Claim Check, and hydrates them in IdentifyStage', async () => {
      const storedFiles = new Map<string, { buffer: Buffer; filename: string }>();
      const storagePort = fromPartial<jest.Mocked<IFilesPort>>({
        uploadFile: jest.fn(async (input) => {
          const fileId = `claim-${storedFiles.size + 1}`;
          storedFiles.set(fileId, {
            buffer: input.buffer,
            filename: input.filename,
          });
          return {
            fileId,
            url: `/api/v1/files/${fileId}/content`,
            path: `storage/${input.filename}`,
            filename: input.filename,
            size: input.buffer.length,
            mimeType: input.mimeType,
          };
        }),
        readOwnedFile: jest.fn(async (input) => {
          const entry = storedFiles.get(input.fileId)!;
          return {
            fileId: input.fileId,
            filename: entry.filename,
            mimeType: 'application/gzip',
            size: entry.buffer.length,
            storageKey: `storage/${entry.filename}`,
            contentUrl: `/api/v1/files/${input.fileId}/content`,
            buffer: entry.buffer,
          };
        }),
      });

      const mockRepo = {
        findRunByIdempotencyKey: jest.fn().mockResolvedValue(null),
        createRun: jest.fn(
          (
            scope: { userId?: string; projectId?: string },
            data: {
              inputParams: { payload: Record<string, unknown> };
              inputHash?: string;
            },
          ) => ({
            id: 'run-uuid-1234',
            userId: scope.userId,
            projectId: scope.projectId,
            status: 'PENDING',
            inputParams: data.inputParams,
            inputHash: data.inputHash,
            startedAt: new Date(),
          }),
        ),
      };
      const mockQueue = { enqueue: jest.fn().mockResolvedValue(true) };

      const ingestionService = new IngestionService(
        mockRepo as never,
        {} as never,
        mockQueue as never,
        {} as never,
        undefined,
        storagePort,
      );

      const smallBib = `@article{einstein1905, title={Relativity}, author={Einstein, Albert}, year={1905}}`;
      await ingestionService.submit({
        userId: 'user-1',
        projectId: 'proj-1',
        payload: { kind: 'RECORD', format: 'BIBTEX', content: smallBib },
      });
      expect(storagePort.uploadFile).not.toHaveBeenCalled();

      const largeBib = Array.from(
        { length: 80 },
        (_, i) =>
          `@article{paper_${i}, title={Scalable Distributed Systems Architecture Paper ${i}}, author={Alpha and Beta and Gamma}, journal={Journal of High Performance Systems}, year={2026}, abstract={${'A'.repeat(280)}}, doi={10.1000/large.${i}}}`,
      ).join('\n\n');
      expect(largeBib.length).toBeGreaterThan(32 * 1024);

      await ingestionService.submit({
        userId: 'user-1',
        projectId: 'proj-1',
        payload: { kind: 'RECORD', format: 'BIBTEX', content: largeBib },
      });
      expect(storagePort.uploadFile).toHaveBeenCalledTimes(1);
      const savedPayload = mockRepo.createRun.mock.calls[1][1].inputParams
        .payload as Record<string, unknown>;
      expect(savedPayload.isOffloaded).toBe(true);
      expect(savedPayload.content).toBeUndefined();

      const compressed = zlib.gzipSync(Buffer.from(smallBib, 'utf-8'));
      storedFiles.set('claim-hydrate', {
        buffer: compressed,
        filename: 'ingest.gz',
      });
      const identifyStage = new IdentifyStage(
        new DoiParser(),
        new BibtexParser(),
        new RisParser(),
        new NormalizationPolicy(),
        storagePort,
      );
      const hydrated = await identifyStage.execute({
        runId: 'run-hydrate',
        payload: {
          kind: 'RECORD',
          format: 'BIBTEX',
          isOffloaded: true,
          fileId: 'claim-hydrate',
          byteSize: compressed.length,
          uncompressedSize: smallBib.length,
        } as never,
        spaceId: 'user-1',
      });
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0].normalizedMetadata.title).toBe('Relativity');
    });

    it('parses identical PDF buffers (same SHA-256) only once across concurrent/sequential uploads', async () => {
      const sharedBuffer = Buffer.from(
        '%PDF-1.7 canonical binary 10.1038/s41586-021-03819-2',
      );
      const extractTrustedMetadata = jest.fn().mockResolvedValue({
        metadata: {
          title: 'AlphaFold',
          doi: '10.1038/s41586-021-03819-2',
          authors: ['Jumper, John'],
          year: 2021,
        },
        isSelfSufficient: true,
        quality: { totalScore: 0.96 },
        provenance: { engineUsed: 'XMP' },
      });

      const resolver = new IdentifyFileResolver(
        new NormalizationPolicy(),
        fromPartial<IFilesPort>({
          readOwnedFile: jest.fn(async ({ fileId }) => ({
            fileId,
            filename: 'paper.pdf',
            mimeType: 'application/pdf',
            size: sharedBuffer.length,
            storageKey: 'cas/1',
            contentUrl: '/content',
            buffer: sharedBuffer,
          })),
        }),
        fromPartial({
          extractTrustedMetadata,
          extractDocumentFromBuffer: jest.fn(),
        }),
      );

      const candidates = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          resolver.resolve(
            { kind: 'FILE', fileId: `f-${i}`, filename: `copy_${i}.pdf` },
            { userId: `u-${i}` },
          ),
        ),
      );
      expect(candidates).toHaveLength(10);
      expect(extractTrustedMetadata).toHaveBeenCalledTimes(1);

      const warmHit = await resolver.resolve(
        { kind: 'FILE', fileId: 'f-late', filename: 'late.pdf' },
        { userId: 'u-late' },
      );
      expect(extractTrustedMetadata).toHaveBeenCalledTimes(1);
      expect(warmHit.sourceRecordId).toBe('f-late');
    });
  });

  describe('ResolveStage, Client-Edge Overrides & IngestionVerifierService', () => {
    it('queries open authorities even when local PDF metadata exists and guards _clientResolved overrides against citation traps', async () => {
      const resolveMock = jest.fn().mockResolvedValue(null);
      const resolveStage = new ResolveStage({ resolve: resolveMock });
      const candidate: MetadataCandidate = {
        candidateId: 'cand-1',
        sourceKind: 'FILE',
        sourceName: 'TrustedPaper',
        retrievedAt: '2025-01-01T00:00:00.000Z',
        confidenceScore: 0.95,
        fields: {},
        normalizedMetadata: {
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani'],
          year: 2017,
          isSelfSufficient: true,
        },
      };
      await resolveStage.execute({
        spaceId: 'scope-1',
        candidates: [candidate],
      });
      expect(resolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Attention Is All You Need' }),
      );

      const normalizer = new NormalizationPolicy();
      const matched = applyUserOverridesToCandidate(
        {
          id: 'cand-ok',
          sourceKind: 'FILE',
          rawData: {},
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            authors: ['Ashish Vaswani'],
          },
          confidenceScore: 0.8,
        },
        {
          _clientResolved: true,
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani', 'Noam Shazeer'],
          year: 2017,
          publicationTitle: 'NeurIPS',
          abstract:
            'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration.',
          doi: '10.48550/arxiv.1706.03762',
        },
        normalizer,
      );
      expect(evaluateCandidateEnrichmentReadiness(matched).shouldSkip).toBe(
        true,
      );

      const trapped = applyUserOverridesToCandidate(
        {
          id: 'cand-trap',
          sourceKind: 'FILE',
          rawData: {},
          fields: {},
          normalizedMetadata: {
            title: 'A Novel Quantum Graph Neural Network for Drug Discovery',
            authors: ['Alice Nguyen'],
          },
          confidenceScore: 0.8,
        },
        {
          _clientResolved: true,
          title: 'Deep Residual Learning for Image Recognition',
          authors: ['Kaiming He'],
          year: 2016,
          publicationTitle: 'CVPR',
          doi: '10.1109/cvpr.2016.90',
        },
        normalizer,
      );
      expect(trapped.normalizedMetadata.title).toBe(
        'A Novel Quantum Graph Neural Network for Drug Discovery',
      );
      expect(trapped.normalizedMetadata.publicationTitle).toBeUndefined();
    });

    it('scores web/local candidates (COMPLETE/PARTIAL/NEEDS_REVIEW/FAILED) and detects 403/429/Cloudflare WAF blocks', () => {
      const verifier = new IngestionVerifierService();
      const fp: PdfFingerprint = verifier.extractFingerprint({
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani'],
        doi: '10.48550/arXiv.1706.03762',
        year: 2017,
      });
      expect(fp.firstAuthorSurname).toBe('vaswani');

      expect(
        verifier.verifyWebCandidate(fp, {
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani'],
          doi: '10.48550/arXiv.1706.03762',
          year: 2017,
          journal: 'NeurIPS',
          abstract: 'Long enough abstract describing sequence transduction models.',
        }).status,
      ).toBe('COMPLETE');

      const disambig = verifier.verifyWebCandidate(fp, {
        title: 'Unrelated Paper Sharing Cited DOI',
        doi: '10.48550/arXiv.1706.03762',
        authors: ['Random Author'],
        year: 2024,
      });
      expect(disambig.status).toBe('NEEDS_REVIEW');
      expect(disambig.isDisambiguationMismatch).toBe(true);

      expect(
        verifier.evaluateLocalResult(
          { title: 'Uploaded Document', authors: ['Unknown'] },
          'LOCAL',
          0.2,
        ).status,
      ).toBe('FAILED');

      expect(
        verifier.detectBlockedStatus('https://biorxiv.org', '', 403).wafKind,
      ).toBe('HTTP_403_FORBIDDEN');
      expect(
        verifier.detectBlockedStatus(
          'https://biorxiv.org',
          '<html><head><title>Just a moment...</title></head></html>',
          200,
        ).wafKind,
      ).toBe('BOT_CHALLENGE_TITLE');
    });
  });

  describe('Metadata Re-Resolution, Enrichment Patch Guards & Commit Stage', () => {
    it('rejects cited baseline DOIs in reconcileExtractedCandidate, re-resolves items (including Vietnamese authors), and protects user locks & multi-author lists', async () => {
      const existingMri: Record<string, unknown> = {
        id: 'item-mri',
        title: 'Self-Supervised Volumetric Transformer for 3D Brain MRI',
        year: 2024,
        doi: '10.1109/cvpr.2016.90',
        version: 1,
        extraFields: {},
      };
      const updateItemMock = jest.fn().mockResolvedValue(existingMri);
      const resolver = new MetadataResolverService(
        fromPartial<ICatalogFacade>({
          getItem: jest.fn().mockResolvedValue(existingMri),
          updateItem: updateItemMock,
        }),
        {
          resolve: jest.fn().mockResolvedValue({
            metadata: {
              title: 'Deep Residual Learning for Image Recognition',
              authors: ['Kaiming He'],
              year: 2016,
              doi: '10.1109/cvpr.2016.90',
            },
            provenance: {},
          }),
        } as unknown as MetadataPort,
      );

      const trapRes = await resolver.reconcileExtractedCandidate({
        userId: 'user-1',
        itemId: 'item-mri',
        extractedMetadata: {
          title: 'Self-Supervised Volumetric Transformer for 3D Brain MRI',
          authors: ['Minh Nguyen'],
          year: 2024,
          doi: '10.1109/cvpr.2016.90',
        },
      });
      expect(trapRes.updated).toBe(false);
      expect(trapRes.rejectedCitedDoi).toBe('10.1109/cvpr.2016.90');

      const mockCatalog = fromPartial<jest.Mocked<ICatalogFacade>>({
        getItem: jest.fn(),
        updateItem: jest.fn(),
      });
      const mockMetaPort: jest.Mocked<MetadataPort> = { resolve: jest.fn() };
      const ingestionSvc = new IngestionService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        mockCatalog,
        undefined,
        mockMetaPort,
      );

      mockCatalog.getItem.mockResolvedValueOnce(null);
      await expect(
        ingestionSvc.reResolveMetadata('u1', 'missing', { doi: '10.1000/1' }),
      ).rejects.toThrow(NotFoundException);

      mockCatalog.getItem.mockResolvedValueOnce(
        fromPartial<ItemDetail>({
          id: 'i1',
          title: 'Uploaded Document',
          version: 1,
        }),
      );
      await expect(
        ingestionSvc.reResolveMetadata('u1', 'i1', {}),
      ).rejects.toThrow(BadRequestException);

      mockCatalog.getItem.mockResolvedValueOnce(
        fromPartial<ItemDetail>({
          id: 'item-vn',
          title: 'Phát hiện bệnh cây trồng',
          doi: '10.1016/j.cropro.2023.10001',
          version: 1,
        }),
      );
      mockMetaPort.resolve.mockResolvedValueOnce({
        query: '10.1016/j.cropro.2023.10001',
        queryType: 'DOI',
        canonicalId: '10.1016/j.cropro.2023.10001',
        metadata: {
          title: 'Deep Learning for Crop Protection in Vietnam',
          authors: ['Nguyễn Văn An', 'Trần Thị Mai'],
          year: 2023,
        },
        provenance: {},
        resolvedAt: '2025-01-01T00:00:00.000Z',
        policyVersion: 1,
      } satisfies ResolvedMetadata);
      mockCatalog.updateItem.mockResolvedValueOnce(
        fromPartial<ItemDetail>({ id: 'item-vn', version: 2 }),
      );

      const vnRes = await ingestionSvc.reResolveMetadata('u1', 'item-vn');
      expect(vnRes.success).toBe(true);
      expect(mockCatalog.updateItem).toHaveBeenCalledWith(
        'u1',
        'item-vn',
        expect.objectContaining({
          creators: expect.arrayContaining([
            expect.objectContaining({
              firstName: 'Văn An',
              lastName: 'Nguyễn',
            }),
          ]),
        }),
        { expectedVersion: 1, projectId: undefined },
      );

      const lockedFiveAuthorItem = {
        id: 'locked-1',
        title: 'User Curated Title',
        year: 2024,
        authors: ['A', 'B', 'C', 'D', 'E'],
        creators: ['A', 'B', 'C', 'D', 'E'].map((fullName, orderIndex) => ({
          creatorType: 'author',
          fullName,
          orderIndex,
        })),
        metadata: { lockedFields: ['title', 'year'] },
        extraFields: { lockedFields: ['title', 'year'] },
      };
      const enrichPatch = buildEnrichmentPatch(lockedFiveAuthorItem, {
        title: 'Blocked By Lock',
        year: 2020,
        authors: ['A'],
        issue: '4',
        sourceProvider: 'CrossRef',
      });
      expect(enrichPatch.title).toBeUndefined();
      expect(enrichPatch.authors).toBeUndefined();
      expect(enrichPatch.issue).toBe('4');

      const reResolvePatch = buildReResolvePatch(lockedFiveAuthorItem, {
        title: 'Blocked',
        publisher: 'Springer Nature',
        sourceProvider: 'CrossRef',
      });
      expect(reResolvePatch.updateData.title).toBeUndefined();
      expect(reResolvePatch.updateData.publisher).toBe('Springer Nature');

      expect(
        toItemData({
          title: 'Paper',
          tags: ['Deep Learning', 'n/a', 'doi: 10.1234/567'],
        } as never).tags,
      ).toEqual(['Deep Learning']);
    });
  });

  describe('IngestionRunAggregate, Saga Orchestration & PipelineService', () => {
    it('tracks forward steps, LIFO compensation rollback, 3-stage IDENTIFY->RESOLVE->COMMIT pipeline, exact-duplicate fast-track, and pre-commit retraction scan', async () => {
      const agg = IngestionRunAggregate.create({
        userId: 'user-1',
        sourceType: 'doi',
      });
      agg.startStep('IDENTIFY');
      agg.completeStep('IDENTIFY', 10);
      agg.complete();
      expect(() => agg.startStep('ENRICH')).toThrow(/Cannot start step/);

      const mockRepo = {
        findRunById: jest.fn().mockResolvedValue(null),
        createStage: jest.fn().mockResolvedValue({ id: 'stage-1' }),
        createCandidate: jest.fn().mockResolvedValue({ id: 'cand-1' }),
        createDecision: jest.fn().mockResolvedValue({ id: 'dec-1' }),
        updateRunStatus: jest.fn().mockResolvedValue({ id: 'run-1' }),
        updateRunStage: jest.fn().mockResolvedValue({ id: 'run-1' }),
      };
      const mockIdentify = {
        execute: jest.fn().mockResolvedValue([
          {
            sourceName: 'doi',
            sourceRecordId: '10.1016/s0140-6736(97)11096-0',
            confidenceScore: 1.0,
            normalizedMetadata: {
              title: 'Wakefield Study',
              doi: '10.1016/s0140-6736(97)11096-0',
            },
          },
        ]),
      };
      const mockResolve = {
        execute: jest.fn((input: { candidates: unknown[] }) =>
          Promise.resolve(input.candidates),
        ),
        coalesceAndVerify: jest.fn().mockResolvedValue({
          proposedItem: {
            title: 'Wakefield Study',
            doi: '10.1016/s0140-6736(97)11096-0',
          },
          conflicts: [],
          selectedFields: { title: 'Wakefield Study' },
        }),
        match: jest.fn().mockResolvedValue({ matchType: 'NONE' }),
      };
      const mockCommit = {
        execute: jest.fn().mockResolvedValue({
          id: 'item-saga-100',
          title: 'Wakefield Study',
        }),
      };
      const mockCatalogFacade = {
        deleteItem: jest.fn().mockResolvedValue(undefined),
      };
      const mockScanner = {
        lookup: jest.fn().mockResolvedValue({
          status: 'retracted',
          details: { nature: 'retraction', reasons: ['Data falsification'] },
        }),
      };

      const orchestrator = new IngestionSagaOrchestrator(mockRepo as never);
      const pipeline = new PipelineService(
        mockRepo as never,
        mockIdentify as never,
        mockResolve as never,
        mockCommit as never,
        mockCatalogFacade as never,
        {
          createAttachment: jest.fn().mockResolvedValue({ id: 'att-1' }),
          createNote: jest.fn().mockResolvedValue({ id: 'note-1' }),
        } as never,
        orchestrator,
        mockScanner as never,
      );

      await pipeline.executePipeline('run-3stages', 'user-42', {
        userId: 'user-42',
        payload: {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: '10.1016/s0140-6736(97)11096-0',
        },
      });
      expect(mockCommit.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          item: expect.objectContaining({
            isRetracted: true,
            retractionNature: 'retraction',
          }),
        }),
      );
      expect(mockRepo.updateRunStatus).toHaveBeenCalledWith(
        'user-42',
        'run-3stages',
        IngestionStatus.COMPLETED,
        expect.objectContaining({ itemId: 'item-saga-100' }),
      );

      mockCommit.execute.mockClear();
      mockResolve.execute.mockClear();
      mockResolve.match.mockResolvedValueOnce({
        matchType: 'EXACT',
        targetItemId: 'existing-999',
      });
      await pipeline.executePipeline('run-dup', 'user-42', {
        userId: 'user-42',
        payload: {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: '10.1016/s0140-6736(97)11096-0',
        },
      });
      expect(mockResolve.execute).not.toHaveBeenCalled();
      expect(mockCommit.execute).not.toHaveBeenCalled();

      mockRepo.updateRunStatus.mockRejectedValueOnce(new Error('Disk full'));
      await expect(
        pipeline.executePipeline('run-rollback', 'user-42', {
          userId: 'user-42',
          payload: {
            kind: 'IDENTIFIER',
            identifierType: 'DOI',
            value: '10.1016/s0140-6736(97)11096-0',
          },
        }),
      ).rejects.toThrow('Disk full');
      expect(mockCatalogFacade.deleteItem).toHaveBeenCalledWith(
        'user-42',
        'item-saga-100',
        undefined,
      );
    });
  });
});
