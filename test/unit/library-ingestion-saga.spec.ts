import { IngestionRunAggregate } from '../../src/modules/library/ingestion/domain/model/ingestion-run.aggregate';
import { IngestionStatusVo } from '../../src/modules/library/ingestion/domain/value-objects/ingestion-status.vo';
import {
  IngestionSagaOrchestrator,
  IngestionSagaSession,
} from '../../src/modules/library/ingestion/application/services/ingestion-saga.orchestrator';
import { IngestionRepository } from '../../src/modules/library/ingestion/infrastructure/repositories/ingestion.repository';
import { ICatalogFacade } from '../../src/modules/library/bibliography/bibliography.facade';
import { IngestionStatus } from '@prisma/client';

describe('Library Ingestion Bounded Context - Saga Orchestration & DDD Lifecycle', () => {
  describe('IngestionRunAggregate Saga Step Tracking', () => {
    it('should create an aggregate with RUNNING status and emit started event', () => {
      const run = IngestionRunAggregate.create({
        userId: 'user-123',
        sourceType: 'doi',
        totalItems: 1,
      });

      expect(run.id).toBeDefined();
      expect(run.userId).toBe('user-123');
      expect(run.status).toBe('RUNNING');
      expect(run.totalItems).toBe(1);
      expect(run.completedSteps).toEqual([]);
      expect(run.currentStep).toBeNull();

      const events = run.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('processing.ingestion_run.started');
    });

    it('should track forward steps and emit step domain events', () => {
      const run = IngestionRunAggregate.create({
        userId: 'user-123',
        sourceType: 'doi',
        totalItems: 1,
      });
      run.pullDomainEvents(); // clear start event

      run.startStep('IDENTIFY');
      expect(run.currentStep).toBe('IDENTIFY');
      const startEvents = run.pullDomainEvents();
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].eventType).toBe(
        'processing.ingestion_run.step_started',
      );

      run.completeStep('IDENTIFY', 45);
      expect(run.currentStep).toBeNull();
      expect(run.completedSteps).toContain('IDENTIFY');
      const compEvents = run.pullDomainEvents();
      expect(compEvents).toHaveLength(1);
      expect(compEvents[0].eventType).toBe(
        'processing.ingestion_run.step_completed',
      );
    });

    it('should record step failure and trigger compensation transition', () => {
      const run = IngestionRunAggregate.create({
        userId: 'user-123',
        sourceType: 'file',
        totalItems: 1,
      });
      run.pullDomainEvents();

      run.startStep('NORMALIZE');
      run.failStep('NORMALIZE', 'Malformed metadata encoding');
      expect(run.currentStep).toBeNull();

      const failEvents = run.pullDomainEvents();
      expect(failEvents).toHaveLength(2);
      expect(failEvents[0].eventType).toBe(
        'processing.ingestion_run.step_started',
      );
      expect(failEvents[1].eventType).toBe(
        'processing.ingestion_run.step_failed',
      );

      // Start compensation
      run.startCompensation('NORMALIZE', 'Malformed metadata encoding');
      expect(run.status).toBe('COMPENSATING');
      expect(run.compensationReason).toBe('Malformed metadata encoding');

      run.recordCompensatedStep('IDENTIFY');
      expect(run.compensatedSteps).toContain('IDENTIFY');

      run.completeCompensation();
      expect(run.status).toBe('FAILED');
      expect(run.errorReason).toBe('Malformed metadata encoding');

      const compEvents = run.pullDomainEvents();
      expect(compEvents.some((e) => e.eventType === 'processing.ingestion_run.compensation_started')).toBe(true);
      expect(compEvents.some((e) => e.eventType === 'processing.ingestion_run.compensation_completed')).toBe(true);
      expect(compEvents.some((e) => e.eventType === 'processing.ingestion_run.failed')).toBe(true);
    });

    it('should disallow starting a step when not in RUNNING status', () => {
      const run = IngestionRunAggregate.create({
        userId: 'user-123',
        sourceType: 'manual',
      });
      run.complete();
      expect(run.status).toBe('COMPLETED');

      expect(() => run.startStep('ENRICH')).toThrow(
        /Cannot start step "ENRICH" on run in status COMPLETED/,
      );
    });
  });

  describe('IngestionSagaOrchestrator & IngestionSagaSession', () => {
    let mockRepo: jest.Mocked<Partial<IngestionRepository>>;
    let mockCatalogFacade: jest.Mocked<Partial<ICatalogFacade>>;
    let orchestrator: IngestionSagaOrchestrator;

    beforeEach(() => {
      mockRepo = {
        createStage: jest.fn().mockResolvedValue({ id: 'stage-1' } as any),
        updateRunStatus: jest.fn().mockResolvedValue({ id: 'run-1' } as any),
      };
      mockCatalogFacade = {
        deleteItem: jest.fn().mockResolvedValue(undefined),
      };
      orchestrator = new IngestionSagaOrchestrator(
        mockRepo as IngestionRepository,
        mockCatalogFacade as ICatalogFacade,
      );
    });

    it('should successfully execute forward steps and persist stage records', async () => {
      const aggregate = IngestionRunAggregate.create({
        userId: 'user-1',
        sourceType: 'doi',
      });
      const session = orchestrator.createSession('run-1', 'user-1', aggregate);

      const step1Result = await session.executeStep('IDENTIFY', async () => {
        return { candidates: [{ id: 'cand-1' }] };
      });
      expect(step1Result.candidates).toHaveLength(1);
      expect(aggregate.completedSteps).toContain('IDENTIFY');
      expect(mockRepo.createStage).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          stageName: 'IDENTIFY',
          success: true,
        }),
      );

      const step2Result = await session.executeStep('NORMALIZE', async () => {
        return { normalized: true };
      });
      expect(step2Result.normalized).toBe(true);
      expect(aggregate.completedSteps).toContain('NORMALIZE');
    });

    it('should execute LIFO backward compensation when a step throws an error', async () => {
      const aggregate = IngestionRunAggregate.create({
        userId: 'user-1',
        sourceType: 'pdf',
      });
      const session = orchestrator.createSession('run-1', 'user-1', aggregate);

      const step1Compensate = jest.fn().mockResolvedValue(undefined);
      const step2Compensate = jest.fn().mockResolvedValue(undefined);

      // Step 1: IDENTIFY with compensation
      await session.executeStep(
        'IDENTIFY',
        async () => 'cand-data',
        { compensate: step1Compensate },
      );

      // Step 2: COMMIT with compensation
      await session.executeStep(
        'COMMIT',
        async () => ({ id: 'item-created-99' }),
        {
          compensate: async (res) => {
            step2Compensate(res.id);
            await mockCatalogFacade.deleteItem!('user-1', res.id);
          },
        },
      );

      expect(session.pendingCompensationsCount).toBe(2);

      // Step 3: Fails post-commit
      await expect(
        session.executeStep('ENRICH_EXISTING', async () => {
          throw new Error('Network timeout during secondary sync');
        }),
      ).rejects.toThrow('Network timeout during secondary sync');

      // Verifications
      expect(session.isCompensating).toBe(true);
      expect(aggregate.status).toBe('FAILED');
      expect(mockRepo.createStage).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          stageName: 'ENRICH_EXISTING',
          success: false,
          errorMessage: 'Network timeout during secondary sync',
        }),
      );

      // Check LIFO compensation execution: step2 compensated first, then step1
      expect(step2Compensate).toHaveBeenCalledWith('item-created-99');
      expect(mockCatalogFacade.deleteItem).toHaveBeenCalledWith(
        'user-1',
        'item-created-99',
      );
      expect(step1Compensate).toHaveBeenCalled();
      expect(mockRepo.updateRunStatus).toHaveBeenCalledWith(
        'user-1',
        'run-1',
        IngestionStatus.FAILED_FINAL,
        expect.objectContaining({
          lastError: expect.stringContaining(
            'Saga rolled back after stage ENRICH_EXISTING',
          ),
        }),
      );
    });
  });

  describe('PipelineService Saga Integration', () => {
    let mockRepo: any;
    let mockIdentify: any;
    let mockNormalize: any;
    let mockEnrich: any;
    let mockReconcile: any;
    let mockMatch: any;
    let mockCommit: any;
    let mockCatalogFacade: any;
    let mockContentFacade: any;
    let orchestrator: IngestionSagaOrchestrator;
    let pipelineService: any;

    beforeEach(async () => {
      const { PipelineService } = await import(
        '../../src/modules/library/ingestion/application/services/pipeline.service'
      );

      mockRepo = {
        findRunById: jest.fn().mockResolvedValue(null),
        createStage: jest.fn().mockResolvedValue({ id: 'stage-1' }),
        createCandidate: jest.fn().mockResolvedValue({ id: 'cand-1' }),
        createDecision: jest.fn().mockResolvedValue({ id: 'dec-1' }),
        updateRunStatus: jest.fn().mockResolvedValue({ id: 'run-1' }),
      };
      mockIdentify = {
        execute: jest.fn().mockResolvedValue([
          {
            sourceName: 'doi',
            sourceRecordId: '10.1038/nature123',
            confidenceScore: 1.0,
            normalizedMetadata: { title: 'Deep Learning', doi: '10.1038/nature123' },
          },
        ]),
      };
      mockNormalize = {
        execute: jest.fn().mockImplementation((cands) => Promise.resolve(cands)),
      };
      mockEnrich = {
        execute: jest.fn().mockImplementation((_scope, cands) => Promise.resolve(cands)),
      };
      mockReconcile = {
        execute: jest.fn().mockResolvedValue({
          proposedItem: { title: 'Deep Learning', doi: '10.1038/nature123' },
          conflicts: [],
          selectedFields: { title: 'Deep Learning' },
        }),
      };
      mockMatch = {
        execute: jest.fn().mockResolvedValue({
          matchType: 'NONE',
        }),
      };
      mockCommit = {
        execute: jest.fn().mockResolvedValue({
          id: 'item-saga-100',
          title: 'Deep Learning',
        }),
      };
      mockCatalogFacade = {
        deleteItem: jest.fn().mockResolvedValue(undefined),
      };
      mockContentFacade = {
        createAttachment: jest.fn().mockResolvedValue({ id: 'att-1' }),
        createNote: jest.fn().mockResolvedValue({ id: 'note-1' }),
      };

      orchestrator = new IngestionSagaOrchestrator(
        mockRepo,
        mockCatalogFacade,
      );

      pipelineService = new PipelineService(
        mockRepo,
        mockIdentify,
        mockNormalize,
        mockEnrich,
        mockReconcile,
        mockMatch,
        mockCommit,
        mockCatalogFacade,
        mockContentFacade,
        orchestrator,
      );
    });

    it('should execute forward pipeline to completion through Saga steps', async () => {
      const envelope = {
        userId: 'user-42',
        payload: { kind: 'IDENTIFIER', value: '10.1038/nature123' } as any,
      };

      await pipelineService.executePipeline('run-100', 'user-42', envelope);

      expect(mockIdentify.execute).toHaveBeenCalled();
      expect(mockNormalize.execute).toHaveBeenCalled();
      expect(mockEnrich.execute).toHaveBeenCalled();
      expect(mockReconcile.execute).toHaveBeenCalled();
      expect(mockMatch.execute).toHaveBeenCalled();
      expect(mockCommit.execute).toHaveBeenCalled();

      expect(mockRepo.updateRunStatus).toHaveBeenCalledWith(
        'user-42',
        'run-100',
        IngestionStatus.READY,
        expect.objectContaining({
          itemId: 'item-saga-100',
        }),
      );
    });

    it('should trigger Saga compensation and rollback committed item if updateRunStatus fails', async () => {
      mockRepo.updateRunStatus = jest
        .fn()
        .mockRejectedValueOnce(new Error('Database disk full on status write'));

      const envelope = {
        userId: 'user-42',
        payload: { kind: 'IDENTIFIER', value: '10.1038/nature123' } as any,
      };

      await expect(
        pipelineService.executePipeline('run-101', 'user-42', envelope),
      ).rejects.toThrow('Database disk full on status write');

      // Verify that the created item was rolled back via catalogFacade.deleteItem
      expect(mockCatalogFacade.deleteItem).toHaveBeenCalledWith(
        'user-42',
        'item-saga-100',
        undefined,
      );
    });
  });
});
