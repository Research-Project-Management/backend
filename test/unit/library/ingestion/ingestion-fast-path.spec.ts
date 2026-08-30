import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { IngestionRepository } from '@/modules/library/ingestion/ingestion.repository';
import { DoiParser } from '@/modules/library/ingestion/parsers/doi.parser';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { DuplicatePolicy } from '@/modules/library/ingestion/policies/duplicate.policy';
import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { NormalizeStage } from '@/modules/library/ingestion/stages/normalize.stage';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { ReconcileStage } from '@/modules/library/ingestion/stages/reconcile.stage';
import { MatchStage } from '@/modules/library/ingestion/stages/match.stage';
import { CommitStage } from '@/modules/library/ingestion/stages/commit.stage';
import { IdempotencyRepository } from '@/modules/library/sync/repositories/idempotency.repository';
import { ConflictException } from '@nestjs/common';
import { IngestionStatus } from '@prisma/client';

describe('Library Ingestion Foundation + Metadata Fast Path (Vertical Slice)', () => {
  let service: IngestionService;
  let mockPrisma: any;
  let mockCatalogService: any;
  let mockMetadataPort: any;

  const workspaceId = 'ws-test-100';
  const userId = 'user-100';

  beforeEach(() => {
    const runsDb = new Map<string, any>();
    const stagesDb: any[] = [];
    const candidatesDb: any[] = [];
    const decisionsDb: any[] = [];
    const reviewCasesDb: any[] = [];
    const catalogDb = new Map<string, any>();

    mockPrisma = {
      workspace: {
        findFirst: jest.fn().mockResolvedValue({ id: workspaceId }),
      },
      ingestionRun: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const run = {
            id: 'run-' + Math.random().toString(36).substring(7),
            ...data,
            attempts: 0,
            startedAt: new Date(),
            completedAt: null,
            stages: [],
            candidates: [],
            decisions: [],
            reviewCases: [],
          };
          runsDb.set(run.id, run);
          return Promise.resolve(run);
        }),
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where.id) {
            const run = runsDb.get(where.id);
            if (!run) return Promise.resolve(null);
            return Promise.resolve({
              ...run,
              stages: stagesDb.filter((s) => s.ingestionRunId === run.id),
              candidates: candidatesDb.filter(
                (c) => c.ingestionRunId === run.id,
              ),
              decisions: decisionsDb.filter((d) => d.ingestionRunId === run.id),
              reviewCases: reviewCasesDb.filter(
                (r) => r.ingestionRunId === run.id,
              ),
            });
          }
          if (where.idempotencyKey) {
            for (const r of runsDb.values()) {
              if (
                r.workspaceId === where.workspaceId &&
                r.idempotencyKey === where.idempotencyKey
              ) {
                return Promise.resolve({ ...r });
              }
            }
          }
          return Promise.resolve(null);
        }),
        update: jest.fn().mockImplementation(({ where, data }: any) => {
          const run = runsDb.get(where.id);
          if (run) {
            Object.assign(run, data);
            if (data.attempts?.increment) run.attempts += 1;
            runsDb.set(where.id, run);
            return Promise.resolve({ ...run });
          }
          return Promise.resolve(null);
        }),
      },
      ingestionStage: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const stage = {
            id: 'stage-' + Math.random().toString(36).substring(7),
            ...data,
            executedAt: new Date(),
          };
          stagesDb.push(stage);
          return Promise.resolve(stage);
        }),
      },
      ingestionCandidate: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const cand = {
            id: 'cand-' + Math.random().toString(36).substring(7),
            ...data,
            fetchedAt: new Date(),
          };
          candidatesDb.push(cand);
          return Promise.resolve(cand);
        }),
      },
      ingestionDecision: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const dec = {
            id: 'dec-' + Math.random().toString(36).substring(7),
            ...data,
            decidedAt: new Date(),
          };
          decisionsDb.push(dec);
          return Promise.resolve(dec);
        }),
      },
      ingestionReviewCase: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const rc = {
            id: 'rc-' + Math.random().toString(36).substring(7),
            ...data,
            createdAt: new Date(),
          };
          reviewCasesDb.push(rc);
          return Promise.resolve(rc);
        }),
      },
      catalogItem: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where.doi) {
            for (const it of catalogDb.values()) {
              if (
                it.workspaceId === where.workspaceId &&
                it.doi === where.doi
              ) {
                return Promise.resolve(it);
              }
            }
          }
          if (where.id) {
            return Promise.resolve(catalogDb.get(where.id) || null);
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const items: any[] = [];
          for (const it of catalogDb.values()) {
            if (it.workspaceId === where.workspaceId) {
              items.push({
                ...it,
                contributors: it.creators || [],
              });
            }
          }
          return Promise.resolve(items);
        }),
      },
    };

    mockCatalogService = {
      createItem: jest.fn().mockImplementation((wsId: string, data: any) => {
        const item = {
          id: 'item-' + Math.random().toString(36).substring(7),
          workspaceId: wsId,
          ...data,
          createdAt: new Date(),
        };
        catalogDb.set(item.id, item);
        return Promise.resolve(item);
      }),
    };

    mockMetadataPort = {
      resolve: jest.fn().mockImplementation(async ({ query }: any) => {
        if (query.includes('10.1038/s41586-020-2003-4')) {
          return {
            query,
            queryType: 'DOI',
            canonicalId: 'doi:10.1038/s41586-020-2003-4',
            metadata: {
              title:
                'A pneumonia outbreak associated with a new coronavirus of probable bat origin',
              doi: '10.1038/s41586-020-2003-4',
              year: 2020,
              publicationTitle: 'Nature',
              volume: '579',
              pages: '270-273',
              authors: ['Zhou, Peng', 'Yang, Xing-Lou'],
            },
            provenance: {
              title: {
                provider: 'CrossRef',
                confidence: 0.95,
                fetchedAt: new Date().toISOString(),
              },
              doi: {
                provider: 'CrossRef',
                confidence: 1.0,
                fetchedAt: new Date().toISOString(),
              },
              year: {
                provider: 'CrossRef',
                confidence: 0.95,
                fetchedAt: new Date().toISOString(),
              },
            },
            resolvedAt: new Date().toISOString(),
            policyVersion: 1,
          };
        }
        return null;
      }),
    };

    const doiParser = new DoiParser();
    const bibtexParser = new BibtexParser();
    const risParser = new RisParser();
    const normalizer = new NormalizationPolicy();
    const reconciler = new ReconciliationPolicy();
    const duplicatePolicy = new DuplicatePolicy();

    const repo = new IngestionRepository(mockPrisma);
    const idempotencyRepo = new IdempotencyRepository(mockPrisma);
    const identifyStage = new IdentifyStage(
      doiParser,
      bibtexParser,
      risParser,
      normalizer,
    );
    const normalizeStage = new NormalizeStage(normalizer);
    const enrichStage = new EnrichStage(mockMetadataPort, normalizer);
    const reconcileStage = new ReconcileStage(reconciler);
    const matchStage = new MatchStage(mockPrisma, duplicatePolicy);
    const commitStage = new CommitStage(mockCatalogService);

    service = new IngestionService(
      mockPrisma,
      undefined,
      idempotencyRepo,
      undefined,
      undefined,
      undefined,
      mockMetadataPort,
      mockCatalogService,
      repo,
    );
  });

  it('executes end-to-end DOI fast-path: detect -> normalize -> enrich -> reconcile -> match -> Catalog commit', async () => {
    const result = await service.submit({
      workspaceId,
      userId,
      payload: {
        kind: 'IDENTIFIER',
        identifierType: 'DOI',
        value: 'https://doi.org/10.1038/s41586-020-2003-4',
      },
    });

    expect(result.runId).toBeDefined();
    expect(result.status).toBe('READY');
    expect(result.existingItemId).toBeDefined();

    const status = await service.getRunStatus(workspaceId, result.runId);
    expect(status.status).toBe(IngestionStatus.READY);
    expect(status.stages.map((s: any) => s.stageName)).toEqual([
      'IDENTIFY',
      'NORMALIZE',
      'ENRICH',
      'RECONCILE',
      'MATCH',
      'COMMIT',
    ]);
    expect(mockCatalogService.createItem).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        title:
          'A pneumonia outbreak associated with a new coronavirus of probable bat origin',
        doi: '10.1038/s41586-020-2003-4',
        year: 2020,
      }),
      expect.anything(),
    );
  });

  it('executes BibTeX fast-path and creates item with extracted metadata', async () => {
    const bibtex = `
@article{attention2017,
  title={Attention Is All You Need},
  author={Vaswani, Ashish and Shazeer, Noam},
  journal={NeurIPS},
  year={2017},
  doi={10.5555/3295222.3295349}
}
`;

    const result = await service.submit({
      workspaceId,
      userId,
      payload: {
        kind: 'RECORD',
        format: 'BIBTEX',
        content: bibtex,
      },
    });

    expect(result.status).toBe('READY');
    expect(mockCatalogService.createItem).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        title: 'Attention Is All You Need',
        doi: '10.5555/3295222.3295349',
        year: 2017,
      }),
      expect.anything(),
    );
  });

  it('enforces atomic idempotency: returns existing run for identical payload', async () => {
    const idempotencyKey = 'key-dedup-100';

    const firstResult = await service.submit({
      workspaceId,
      userId,
      idempotencyKey,
      payload: {
        kind: 'IDENTIFIER',
        identifierType: 'DOI',
        value: '10.1038/s41586-020-2003-4',
      },
    });

    const secondResult = await service.submit({
      workspaceId,
      userId,
      idempotencyKey,
      payload: {
        kind: 'IDENTIFIER',
        identifierType: 'DOI',
        value: '10.1038/s41586-020-2003-4',
      },
    });

    expect(secondResult.runId).toBe(firstResult.runId);
    expect(secondResult.deduplicated).toBe(true);
  });

  it('throws 409 Conflict when idempotency key is reused with a different request payload', async () => {
    const idempotencyKey = 'key-conflict-200';

    await service.submit({
      workspaceId,
      userId,
      idempotencyKey,
      payload: {
        kind: 'IDENTIFIER',
        identifierType: 'DOI',
        value: '10.1038/s41586-020-2003-4',
      },
    });

    await expect(
      service.submit({
        workspaceId,
        userId,
        idempotencyKey,
        payload: {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: '10.1109/5.771073',
        },
      }),
    ).rejects.toThrow(ConflictException);
  });
});
