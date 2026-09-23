/**
 * test/unit/manuscripts-document-updater.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Document Updater Subsystem.
 * (In-Flight Document Buffer & Docstore Flush Engine - Overleaf Parity).
 *
 * Validates:
 *  1. Value Objects: FlushStatusVo, DocumentVersionVo, UpdateOpVo.
 *  2. Domain Aggregate: InFlightDoc (State machine, dirty tracking, sequence advancement).
 *  3. Adapters:
 *      - InMemoryInFlightStoreAdapter: Multi-doc & multi-project dirty indexing.
 *      - LocalMutexUpdaterLockAdapter: Exclusive locks, concurrent rejection, TTL expiration.
 *      - NodeTimeoutDebounceAdapter: Debouncing, timer resets, cancellation.
 *  4. Use Cases:
 *      - QueueDocUpdateUseCase: In-flight buffering, baseline hydration, lock guards, debouncing.
 *      - FlushSingleDocUseCase: Docstore commit, rev advancement, OCC conflict handling.
 *      - FlushProjectDocsUseCase: "Flush-Before-Compile" batch synchronization.
 *      - GetInFlightDocUseCase: Peek buffered state vs persistent baseline.
 *      - EvictDocBufferUseCase: Clean eviction with pre-flush.
 *  5. DocumentUpdaterService & DocumentUpdaterController: REST APIs and orchestration.
 */

import { DocumentUpdaterService } from '@/modules/manuscripts/document-updater/document-updater.service';
import { DocumentUpdaterController } from '@/modules/manuscripts/document-updater/document-updater.controller';
import { QueueDocUpdateUseCase } from '@/modules/manuscripts/document-updater/core/use-cases/queue-doc-update.use-case';
import { FlushProjectDocsUseCase } from '@/modules/manuscripts/document-updater/core/use-cases/flush-project-docs.use-case';
import { FlushSingleDocUseCase } from '@/modules/manuscripts/document-updater/core/use-cases/flush-single-doc.use-case';
import { GetInFlightDocUseCase } from '@/modules/manuscripts/document-updater/core/use-cases/get-in-flight-doc.use-case';
import { EvictDocBufferUseCase } from '@/modules/manuscripts/document-updater/core/use-cases/evict-doc-buffer.use-case';
import { IInFlightStorePort } from '@/modules/manuscripts/document-updater/core/ports/in-flight-store.port';
import { IDocstoreWriterPort, BaseDocData, CommitResult } from '@/modules/manuscripts/document-updater/core/ports/docstore-writer.port';
import { IUpdaterLockPort } from '@/modules/manuscripts/document-updater/core/ports/updater-lock.port';
import { IDebounceTimerPort } from '@/modules/manuscripts/document-updater/core/ports/debounce-timer.port';
import { InMemoryInFlightStoreAdapter } from '@/modules/manuscripts/document-updater/core/adapters/storage/in-memory-in-flight-store.adapter';
import { LocalMutexUpdaterLockAdapter } from '@/modules/manuscripts/document-updater/core/adapters/lock/local-mutex-updater-lock.adapter';
import { NodeTimeoutDebounceAdapter } from '@/modules/manuscripts/document-updater/core/adapters/scheduler/node-timeout-debounce.adapter';
import { InFlightDoc } from '@/modules/manuscripts/document-updater/core/domain/entities/in-flight-doc.entity';
import { DocumentVersionVo } from '@/modules/manuscripts/document-updater/core/domain/value-objects/document-version.vo';
import { UpdateOpVo } from '@/modules/manuscripts/document-updater/core/domain/value-objects/update-op.vo';
import { FlushStatusVo, FlushStatusEnum } from '@/modules/manuscripts/document-updater/core/domain/value-objects/flush-status.vo';
import { DocumentLockedException } from '@/modules/manuscripts/document-updater/core/domain/exceptions/document-locked.exception';
import { DocUpdaterConflictException } from '@/modules/manuscripts/document-updater/core/domain/exceptions/doc-updater-conflict.exception';
import { InFlightNotFoundException } from '@/modules/manuscripts/document-updater/core/domain/exceptions/in-flight-not-found.exception';

/**
 * Mock Test Double for IDocstoreWriterPort simulating DocstoreService
 */
class MockDocstoreWriter implements IDocstoreWriterPort {
  public docs = new Map<string, { lines: string[]; rev: number; version: number }>();
  public simulateConflict = false;

  private toKey(projectId: string, docId: string): string {
    return `${projectId}:${docId}`;
  }

  public async fetchBaseDoc(projectId: string, docId: string): Promise<BaseDocData | null> {
    const data = this.docs.get(this.toKey(projectId, docId));
    if (!data) return null;
    return {
      docId,
      projectId,
      lines: [...data.lines],
      rev: data.rev,
      version: data.version,
    };
  }

  public async commitDocUpdate(
    projectId: string,
    docId: string,
    lines: string[],
    rev: number,
  ): Promise<CommitResult> {
    const key = this.toKey(projectId, docId);
    const existing = this.docs.get(key);

    if (this.simulateConflict) {
      throw new DocUpdaterConflictException(docId, rev, (existing?.rev ?? 0) + 1);
    }

    if (existing && existing.rev !== rev) {
      throw new DocUpdaterConflictException(docId, rev, existing.rev);
    }

    const newRev = rev + 1;
    const version = (existing?.version ?? 0) + 1;
    this.docs.set(key, { lines: [...lines], rev: newRev, version });

    return {
      docId,
      newRev,
      version,
      hash: 'computed-mock-hash',
    };
  }
}

describe('Manuscripts - DocumentUpdater Subsystem (In-Flight Buffer & Docstore Flush)', () => {
  const PROJECT_ID = 'b7d5a570-3d7c-482a-9e53-488b0a996df1';
  const DOC_ID = 'd1a2b3c4-0001-4000-8000-000000000001';

  let inFlightStore: IInFlightStorePort;
  let docstoreWriter: MockDocstoreWriter;
  let lock: IUpdaterLockPort;
  let debounceTimer: IDebounceTimerPort;

  let queueUpdateUseCase: QueueDocUpdateUseCase;
  let flushSingleDocUseCase: FlushSingleDocUseCase;
  let flushProjectUseCase: FlushProjectDocsUseCase;
  let getInFlightDocUseCase: GetInFlightDocUseCase;
  let evictDocBufferUseCase: EvictDocBufferUseCase;

  let service: DocumentUpdaterService;
  let controller: DocumentUpdaterController;

  beforeEach(() => {
    inFlightStore = new InMemoryInFlightStoreAdapter();
    docstoreWriter = new MockDocstoreWriter();
    lock = new LocalMutexUpdaterLockAdapter();
    debounceTimer = new NodeTimeoutDebounceAdapter();

    // Pre-populate mock docstore with a baseline LaTeX document
    docstoreWriter.docs.set(`${PROJECT_ID}:${DOC_ID}`, {
      lines: ['\\documentclass{article}', '\\begin{document}', 'Hello World', '\\end{document}'],
      rev: 1,
      version: 1,
    });

    flushSingleDocUseCase = new FlushSingleDocUseCase(inFlightStore, docstoreWriter, lock, debounceTimer);
    queueUpdateUseCase = new QueueDocUpdateUseCase(inFlightStore, docstoreWriter, lock, debounceTimer);
    flushProjectUseCase = new FlushProjectDocsUseCase(inFlightStore, lock, debounceTimer, flushSingleDocUseCase);
    getInFlightDocUseCase = new GetInFlightDocUseCase(inFlightStore, docstoreWriter);
    evictDocBufferUseCase = new EvictDocBufferUseCase(inFlightStore, debounceTimer, flushSingleDocUseCase);

    service = new DocumentUpdaterService(
      queueUpdateUseCase,
      flushProjectUseCase,
      flushSingleDocUseCase,
      getInFlightDocUseCase,
      evictDocBufferUseCase,
      inFlightStore,
    );
    service.onModuleInit();

    controller = new DocumentUpdaterController(service);
  });

  afterEach(() => {
    debounceTimer.cancelAll();
  });

  // =========================================================================
  // 1. VALUE OBJECTS
  // =========================================================================
  describe('Value Objects', () => {
    describe('FlushStatusVo', () => {
      it('should create and transition through states properly', () => {
        const cleanStatus = FlushStatusVo.clean();
        expect(cleanStatus.value).toBe(FlushStatusEnum.CLEAN);
        expect(cleanStatus.isClean()).toBe(true);
        expect(cleanStatus.isDirty()).toBe(false);

        const dirtyStatus = FlushStatusVo.dirty();
        expect(dirtyStatus.value).toBe(FlushStatusEnum.DIRTY);
        expect(dirtyStatus.isDirty()).toBe(true);

        const flushingStatus = FlushStatusVo.flushing();
        expect(flushingStatus.value).toBe(FlushStatusEnum.FLUSHING);
        expect(flushingStatus.isFlushing()).toBe(true);

        const failedStatus = FlushStatusVo.failed();
        expect(failedStatus.value).toBe(FlushStatusEnum.FAILED);
      });
    });

    describe('DocumentVersionVo', () => {
      it('should track persistent rev and in-flight sequence correctly', () => {
        const v0 = DocumentVersionVo.initial(5);
        expect(v0.rev).toBe(5);
        expect(v0.inFlightSeq).toBe(0);

        const v1 = v0.nextOp();
        expect(v1.rev).toBe(5);
        expect(v1.inFlightSeq).toBe(1);

        const v2 = v1.nextOp();
        expect(v2.inFlightSeq).toBe(2);

        // After successful flush to docstore, rev advances and sequence resets
        const vFlushed = v2.afterFlush(6);
        expect(vFlushed.rev).toBe(6);
        expect(vFlushed.inFlightSeq).toBe(0);
      });
    });

    describe('UpdateOpVo', () => {
      it('should replace entire lines array when created from lines', () => {
        const baseLines = ['line 1', 'line 2'];
        const op = UpdateOpVo.fromLines(['new line 1', 'new line 2', 'new line 3']);

        const result = op.applyTo(baseLines);
        expect(result).toEqual(['new line 1', 'new line 2', 'new line 3']);
      });

      it('should apply splice delta to base lines', () => {
        const baseLines = ['a', 'b', 'c', 'd'];
        // Replace 'b' and 'c' (startLine 1, deleteCount 2) with 'X', 'Y', 'Z'
        const op = UpdateOpVo.fromSplice(1, 2, ['X', 'Y', 'Z']);

        const result = op.applyTo(baseLines);
        expect(result).toEqual(['a', 'X', 'Y', 'Z', 'd']);
      });
    });
  });

  // =========================================================================
  // 2. DOMAIN AGGREGATE ENTITY (InFlightDoc)
  // =========================================================================
  describe('InFlightDoc Entity', () => {
    it('should initialize cleanly and accumulate updates', () => {
      const doc = InFlightDoc.create({
        docId: DOC_ID,
        projectId: PROJECT_ID,
        lines: ['line 1'],
        version: DocumentVersionVo.initial(1),
      });

      expect(doc.isDirty).toBe(false);
      expect(doc.rev).toBe(1);
      expect(doc.inFlightSeq).toBe(0);
      expect(doc.pendingOpsCount).toBe(0);

      // Apply first update
      doc.applyUpdate(UpdateOpVo.fromLines(['line 1', 'line 2']));
      expect(doc.isDirty).toBe(true);
      expect(doc.inFlightSeq).toBe(1);
      expect(doc.pendingOpsCount).toBe(1);
      expect(doc.lines).toEqual(['line 1', 'line 2']);

      // Apply second update
      doc.applyUpdate(UpdateOpVo.fromLines(['line 1', 'line 2', 'line 3']));
      expect(doc.inFlightSeq).toBe(2);
      expect(doc.pendingOpsCount).toBe(2);

      // Mark flushing
      doc.markFlushing();
      expect(doc.isFlushing).toBe(true);

      // Mark flushed
      doc.markFlushed(2);
      expect(doc.isDirty).toBe(false);
      expect(doc.isFlushing).toBe(false);
      expect(doc.rev).toBe(2);
      expect(doc.inFlightSeq).toBe(0);
      expect(doc.pendingOpsCount).toBe(0);
    });

    it('should correctly format joined raw text', () => {
      const doc = InFlightDoc.create({
        docId: DOC_ID,
        projectId: PROJECT_ID,
        lines: ['alpha', 'beta', 'gamma'],
      });
      expect(doc.toRawText()).toBe('alpha\nbeta\ngamma');
    });
  });

  // =========================================================================
  // 3. ADAPTERS
  // =========================================================================
  describe('Adapters', () => {
    describe('InMemoryInFlightStoreAdapter', () => {
      it('should save, retrieve and index dirty docs correctly', async () => {
        const doc1 = InFlightDoc.create({
          docId: 'doc-1',
          projectId: PROJECT_ID,
          lines: ['a'],
        });
        const doc2 = InFlightDoc.create({
          docId: 'doc-2',
          projectId: PROJECT_ID,
          lines: ['b'],
        });

        await inFlightStore.save(doc1);
        await inFlightStore.save(doc2);

        // Initially neither is dirty
        expect(await inFlightStore.getDirtyDocIds(PROJECT_ID)).toEqual([]);

        // Mark doc1 as dirty
        doc1.applyUpdate(UpdateOpVo.fromLines(['a modified']));
        await inFlightStore.save(doc1);

        const dirtyIds = await inFlightStore.getDirtyDocIds(PROJECT_ID);
        expect(dirtyIds).toEqual(['doc-1']);

        // Mark doc1 as flushed
        doc1.markFlushed(1);
        await inFlightStore.save(doc1);
        expect(await inFlightStore.getDirtyDocIds(PROJECT_ID)).toEqual([]);
      });
    });

    describe('LocalMutexUpdaterLockAdapter', () => {
      it('should acquire lock and reject concurrent acquisition until released', async () => {
        const resource = `project:${PROJECT_ID}`;

        const lock1 = await lock.acquire(resource, 5000);
        expect(lock1).toBe(true);

        const lock2 = await lock.acquire(resource, 5000);
        expect(lock2).toBe(false); // Rejected!

        expect(await lock.isLocked(resource)).toBe(true);

        await lock.release(resource);
        expect(await lock.isLocked(resource)).toBe(false);

        const lock3 = await lock.acquire(resource, 5000);
        expect(lock3).toBe(true);
        await lock.release(resource);
      });
    });

    describe('NodeTimeoutDebounceAdapter', () => {
      it('should debounce multiple rapid events and trigger only the last one', async () => {
        let callCount = 0;
        const callback = async () => {
          callCount++;
        };

        // Fire 3 times rapidly
        debounceTimer.schedule(PROJECT_ID, DOC_ID, 50, callback);
        debounceTimer.schedule(PROJECT_ID, DOC_ID, 50, callback);
        debounceTimer.schedule(PROJECT_ID, DOC_ID, 50, callback);

        // Wait for debounce timer to fire
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(callCount).toBe(1);
      });
    });
  });

  // =========================================================================
  // 4. USE CASES
  // =========================================================================
  describe('Use Cases', () => {
    it('QueueDocUpdateUseCase: should hydrate doc from docstore, buffer update, and not hit database', async () => {
      const result = await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
        lines: ['\\documentclass{article}', '\\begin{document}', 'Updated Text In-Memory', '\\end{document}'],
      });

      expect(result.docId).toBe(DOC_ID);
      expect(result.isDirty).toBe(true);
      expect(result.inFlightSeq).toBe(1);
      expect(result.pendingOpsCount).toBe(1);

      // Verify persistent docstore still has original baseline (0 database writes!)
      const dbDoc = await docstoreWriter.fetchBaseDoc(PROJECT_ID, DOC_ID);
      expect(dbDoc?.lines[2]).toBe('Hello World');

      // Verify in-flight store holds the hot edited text
      const inFlight = await inFlightStore.get(PROJECT_ID, DOC_ID);
      expect(inFlight?.lines[2]).toBe('Updated Text In-Memory');
    });

    it('QueueDocUpdateUseCase: should reject updates when project is locked', async () => {
      await lock.acquire(`project:${PROJECT_ID}`, 5000);

      await expect(
        queueUpdateUseCase.execute({
          projectId: PROJECT_ID,
          docId: DOC_ID,
          lines: ['Blocked Line'],
        }),
      ).rejects.toThrow(DocumentLockedException);

      await lock.release(`project:${PROJECT_ID}`);
    });

    it('FlushSingleDocUseCase: should commit dirty lines into docstore and advance rev', async () => {
      // 1. Queue update in memory
      await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
        lines: ['\\documentclass{article}', 'New Content Flushed', '\\end{document}'],
      });

      // 2. Flush single doc
      const flushResult = await flushSingleDocUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
      });

      expect(flushResult.flushed).toBe(true);
      expect(flushResult.newRev).toBe(2);

      // Verify docstore has the new lines committed
      const dbDoc = await docstoreWriter.fetchBaseDoc(PROJECT_ID, DOC_ID);
      expect(dbDoc?.rev).toBe(2);
      expect(dbDoc?.lines[1]).toBe('New Content Flushed');

      // In-flight buffer must now be clean
      const inFlight = await inFlightStore.get(PROJECT_ID, DOC_ID);
      expect(inFlight?.isDirty).toBe(false);
      expect(inFlight?.rev).toBe(2);
    });

    it('FlushSingleDocUseCase: should handle OCC conflict and mark document failed', async () => {
      await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
        lines: ['Conflicting update'],
      });

      // Simulate external concurrent database modification
      docstoreWriter.simulateConflict = true;

      await expect(
        flushSingleDocUseCase.execute({
          projectId: PROJECT_ID,
          docId: DOC_ID,
        }),
      ).rejects.toThrow(DocUpdaterConflictException);

      const inFlight = await inFlightStore.get(PROJECT_ID, DOC_ID);
      expect(inFlight?.status.value).toBe(FlushStatusEnum.FAILED);
    });

    it('FlushProjectDocsUseCase (Flush-Before-Compile): should flush all dirty docs in a project', async () => {
      const DOC_ID_2 = 'd1a2b3c4-0002-4000-8000-000000000002';
      docstoreWriter.docs.set(`${PROJECT_ID}:${DOC_ID_2}`, {
        lines: ['\\section{Introduction}'],
        rev: 1,
        version: 1,
      });

      // Queue updates to 2 different documents
      await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
        lines: ['main.tex updated'],
      });

      await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID_2,
        lines: ['intro.tex updated'],
      });

      // Trigger Flush-Before-Compile
      const projectFlushResult = await flushProjectUseCase.execute({
        projectId: PROJECT_ID,
      });

      expect(projectFlushResult.flushedDocsCount).toBe(2);
      expect(projectFlushResult.flushedDocIds).toContain(DOC_ID);
      expect(projectFlushResult.flushedDocIds).toContain(DOC_ID_2);
      expect(projectFlushResult.errors.length).toBe(0);

      // Verify both docs are persisted in Docstore
      const doc1 = await docstoreWriter.fetchBaseDoc(PROJECT_ID, DOC_ID);
      const doc2 = await docstoreWriter.fetchBaseDoc(PROJECT_ID, DOC_ID_2);
      expect(doc1?.lines).toEqual(['main.tex updated']);
      expect(doc2?.lines).toEqual(['intro.tex updated']);
    });

    it('GetInFlightDocUseCase: should return buffered doc if active, or load baseline if not', async () => {
      // 1. Not in buffer yet -> loads baseline
      const res1 = await getInFlightDocUseCase.execute({ projectId: PROJECT_ID, docId: DOC_ID });
      expect(res1.isBuffered).toBe(false);
      expect(res1.doc.lines[0]).toBe('\\documentclass{article}');

      // 2. Queue an edit -> now buffered
      await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
        lines: ['In memory active buffer'],
      });

      const res2 = await getInFlightDocUseCase.execute({ projectId: PROJECT_ID, docId: DOC_ID });
      expect(res2.isBuffered).toBe(true);
      expect(res2.doc.lines[0]).toBe('In memory active buffer');
    });

    it('EvictDocBufferUseCase: should flush dirty changes before eviction', async () => {
      await queueUpdateUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
        lines: ['Eviction test content'],
      });

      await evictDocBufferUseCase.execute({
        projectId: PROJECT_ID,
        docId: DOC_ID,
      });

      // Must be evicted from memory
      const inFlight = await inFlightStore.get(PROJECT_ID, DOC_ID);
      expect(inFlight).toBeNull();

      // Must have been flushed to persistent docstore before eviction!
      const dbDoc = await docstoreWriter.fetchBaseDoc(PROJECT_ID, DOC_ID);
      expect(dbDoc?.lines).toEqual(['Eviction test content']);
    });
  });

  // =========================================================================
  // 5. SERVICE & CONTROLLER (HTTP REST API)
  // =========================================================================
  describe('DocumentUpdaterService & Controller', () => {
    it('Controller: POST /project/:projectId/doc/:docId/update should accept edits', async () => {
      const response = await controller.queueUpdate(PROJECT_ID, DOC_ID, {
        lines: ['API update test'],
      });

      expect(response.docId).toBe(DOC_ID);
      expect(response.isDirty).toBe(true);
    });

    it('Controller: POST /project/:projectId/flush should flush project docs', async () => {
      await controller.queueUpdate(PROJECT_ID, DOC_ID, {
        lines: ['API flush test'],
      });

      const flushRes = await controller.flushProject(PROJECT_ID);
      expect(flushRes.flushedDocsCount).toBe(1);
      expect(flushRes.flushedDocIds).toContain(DOC_ID);
    });

    it('Controller: GET /project/:projectId/doc/:docId/state should return state DTO', async () => {
      const state = await controller.getDocState(PROJECT_ID, DOC_ID);
      expect(state.docId).toBe(DOC_ID);
      expect(state.projectId).toBe(PROJECT_ID);
      expect(Array.isArray(state.lines)).toBe(true);
    });

    it('Controller: DELETE /project/:projectId/doc/:docId/buffer should evict buffer', async () => {
      await controller.evictDoc(PROJECT_ID, DOC_ID);
      const inFlight = await inFlightStore.get(PROJECT_ID, DOC_ID);
      expect(inFlight).toBeNull();
    });
  });
});
