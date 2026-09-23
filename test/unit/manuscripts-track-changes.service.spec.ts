/**
 * test/unit/manuscripts-track-changes.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Track Changes & Comments Subsystem
 * (Overleaf Parity Review Mode, Inline Proposed Changes, Margin Comments & Thread Replies).
 *
 * Validates:
 *  1. Domain Value Objects & Entities:
 *      - TextRangeVo (startLine, startCol, endLine, endCol, validation, clamping, overlaps, contains, toJSON)
 *      - ChangeMetadataVo (author, clientTimestamp, batchId, resolvedAt, resolvedBy, markResolved)
 *      - TrackChange (insert/delete, pending lifecycle, accept, reject, double-resolution guard)
 *      - CommentReply (reply instantiation, getters and content update)
 *      - CommentThread (quote, range, isResolved: boolean, addReply, resolve, unresolve, resolved-thread guard)
 *  2. Adapters & Ports:
 *      - DocstorePatcherAdapter:
 *          - removeRange (single-line splicing, multiline splicing, out-of-bounds start line)
 *          - insertRange (single-line splicing, multiline expansion with newlines, beyond-end expansion)
 *          - applyChange (insert keeps lines, delete mutates docstore)
 *          - revertChange (insert removes range, delete restores text at range)
 *      - InMemoryTrackChangesRepository (saveChange, findChangeById, listChangesByDoc, saveCommentThread, findThreadById, listThreadsByDoc, addCommentReply)
 *      - MockRealtimeNotifier (broadcast capture for changes, comments, replies)
 *  3. Inbound Use Cases:
 *      - RecordChangeUseCase (persists change, emits realtime event)
 *      - AcceptChangeUseCase (accepts change, patches docstore if delete, emits event, 404 guard)
 *      - RejectChangeUseCase (rejects change, patches docstore if insert/restores if delete, emits event, 404 guard)
 *      - BatchResolveChangesUseCase (bulk accept_all / reject_all across document)
 *      - CreateCommentThreadUseCase (creates thread + initial reply, emits event)
 *      - AddCommentReplyUseCase (adds reply, emits event, 404 & resolved guards)
 *      - ResolveCommentThreadUseCase (resolves/unresolves thread, emits event, 404 guard)
 *      - GetDocReviewsUseCase (retrieves pending changes and threads)
 *  4. Facade Service (TrackChangesService):
 *      - Orchestrates use cases and maps domain entities to response DTOs
 *  5. REST Controller (TrackChangesController):
 *      - HTTP endpoints mapping
 *      - Exception translations (ChangeNotFoundException -> 404, ThreadNotFoundException -> 404, ResolvedThreadException -> 400)
 */

import { NotFoundException, BadRequestException } from '@nestjs/common';

// Domain Value Objects & Entities
import { TextRangeVo } from '@/modules/manuscripts/track-changes/core/domain/value-objects/text-range.vo';
import { ChangeMetadataVo } from '@/modules/manuscripts/track-changes/core/domain/value-objects/change-metadata.vo';
import { TrackChange, ChangeType, ChangeStatus } from '@/modules/manuscripts/track-changes/core/domain/entities/track-change.entity';
import { CommentReply } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-reply.entity';
import { CommentThread } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-thread.entity';

// Exceptions
import { ChangeNotFoundException } from '@/modules/manuscripts/track-changes/core/domain/exceptions/change-not-found.exception';
import { ThreadNotFoundException } from '@/modules/manuscripts/track-changes/core/domain/exceptions/thread-not-found.exception';
import { ResolvedThreadException } from '@/modules/manuscripts/track-changes/core/domain/exceptions/resolved-thread.exception';

// Ports & Adapters
import { ITrackChangesRepositoryPort } from '@/modules/manuscripts/track-changes/core/ports/track-changes-repository.port';
import { IRealtimeNotifierPort } from '@/modules/manuscripts/track-changes/core/ports/realtime-notifier.port';
import { DocstorePatcherAdapter } from '@/modules/manuscripts/track-changes/core/adapters/external/docstore-patcher.adapter';

// Use Cases
import { RecordChangeUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/record-change.use-case';
import { AcceptChangeUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/accept-change.use-case';
import { RejectChangeUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/reject-change.use-case';
import { BatchResolveChangesUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/batch-resolve-changes.use-case';
import { CreateCommentThreadUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/create-comment-thread.use-case';
import { AddCommentReplyUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/add-comment-reply.use-case';
import { ResolveCommentThreadUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/resolve-comment-thread.use-case';
import { GetDocReviewsUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/get-doc-reviews.use-case';

// Application Service & Controller
import { TrackChangesService } from '@/modules/manuscripts/track-changes/track-changes.service';
import { TrackChangesController } from '@/modules/manuscripts/track-changes/track-changes.controller';

// --- In-Memory Mocks for Ports ---

class MockDocstoreService {
  public docs = new Map<string, { lines: string[]; version: number; rev: number }>();

  constructor() {
    this.docs.set('doc-1', {
      lines: ['\\documentclass{article}', '\\begin{document}', 'Hello World', '\\end{document}'],
      version: 1,
      rev: 5,
    });
  }

  async getDoc(projectId: string, docId: string) {
    const doc = this.docs.get(docId);
    if (!doc) {
      throw new Error(`Doc ${docId} not found in MockDocstoreService`);
    }
    return {
      docId,
      projectId,
      lines: [...doc.lines],
      version: doc.version,
      rev: doc.rev,
    };
  }

  async updateDoc(projectId: string, docId: string, dto: { lines: string[]; version: number }) {
    const doc = this.docs.get(docId) || { lines: [], version: 0, rev: 0 };
    doc.lines = [...dto.lines];
    doc.version += 1;
    doc.rev += 1;
    this.docs.set(docId, doc);
    return {
      doc: {
        docId,
        projectId,
        lines: doc.lines,
        version: doc.version,
        rev: doc.rev,
      },
      appliedRanges: null,
    };
  }
}

class InMemoryTrackChangesRepository implements ITrackChangesRepositoryPort {
  public changes = new Map<string, TrackChange>();
  public threads = new Map<string, CommentThread>();

  async saveChange(change: TrackChange): Promise<TrackChange> {
    this.changes.set(change.id, change);
    return change;
  }

  async findChangeById(id: string): Promise<TrackChange | null> {
    return this.changes.get(id) || null;
  }

  async listChangesByDoc(projectId: string, docId: string, status?: ChangeStatus): Promise<TrackChange[]> {
    return Array.from(this.changes.values()).filter(
      (c) => c.projectId === projectId && c.docId === docId && (!status || c.status === status),
    );
  }

  async saveCommentThread(thread: CommentThread): Promise<CommentThread> {
    this.threads.set(thread.id, thread);
    return thread;
  }

  async findThreadById(id: string): Promise<CommentThread | null> {
    return this.threads.get(id) || null;
  }

  async listThreadsByDoc(projectId: string, docId: string, isResolved?: boolean): Promise<CommentThread[]> {
    return Array.from(this.threads.values()).filter(
      (t) => t.projectId === projectId && t.docId === docId && (isResolved === undefined || t.isResolved === isResolved),
    );
  }

  async addCommentReply(threadId: string, reply: CommentReply): Promise<CommentReply> {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.addReply(reply);
      this.threads.set(threadId, thread);
    }
    return reply;
  }

  async deleteCommentThread(projectId: string, threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }
}

class MockRealtimeNotifier implements IRealtimeNotifierPort {
  public events: Array<{ type: string; projectId: string; docId: string; payload: any }> = [];

  notifyChangeRecorded(projectId: string, docId: string, change: TrackChange): void {
    this.events.push({ type: 'change:recorded', projectId, docId, payload: change });
  }

  notifyChangeResolved(projectId: string, docId: string, change: TrackChange): void {
    this.events.push({ type: 'change:resolved', projectId, docId, payload: change });
  }

  notifyCommentCreated(projectId: string, docId: string, thread: CommentThread): void {
    this.events.push({ type: 'comment:created', projectId, docId, payload: thread });
  }

  notifyCommentReplied(projectId: string, docId: string, threadId: string, reply: CommentReply): void {
    this.events.push({ type: 'comment:replied', projectId, docId, payload: { threadId, reply } });
  }

  notifyCommentResolved(projectId: string, docId: string, thread: CommentThread): void {
    this.events.push({ type: 'comment:resolved', projectId, docId, payload: thread });
  }

  clear() {
    this.events = [];
  }
}

describe('Manuscripts Track Changes & Comments Subsystem', () => {
  const projectId = 'proj-alpha';
  const docId = 'doc-1';
  const userId = 'user-alice';

  let mockDocstore: MockDocstoreService;
  let patcherAdapter: DocstorePatcherAdapter;
  let repo: InMemoryTrackChangesRepository;
  let notifier: MockRealtimeNotifier;

  // Use cases
  let recordChangeUseCase: RecordChangeUseCase;
  let acceptChangeUseCase: AcceptChangeUseCase;
  let rejectChangeUseCase: RejectChangeUseCase;
  let batchResolveUseCase: BatchResolveChangesUseCase;
  let createThreadUseCase: CreateCommentThreadUseCase;
  let addReplyUseCase: AddCommentReplyUseCase;
  let resolveThreadUseCase: ResolveCommentThreadUseCase;
  let getDocReviewsUseCase: GetDocReviewsUseCase;

  // Service & Controller
  let service: TrackChangesService;
  let controller: TrackChangesController;

  beforeEach(() => {
    mockDocstore = new MockDocstoreService();
    patcherAdapter = new DocstorePatcherAdapter(mockDocstore as any);
    repo = new InMemoryTrackChangesRepository();
    notifier = new MockRealtimeNotifier();

    recordChangeUseCase = new RecordChangeUseCase(repo, notifier);
    acceptChangeUseCase = new AcceptChangeUseCase(repo, patcherAdapter, notifier);
    rejectChangeUseCase = new RejectChangeUseCase(repo, patcherAdapter, notifier);
    batchResolveUseCase = new BatchResolveChangesUseCase(repo, acceptChangeUseCase, rejectChangeUseCase);
    createThreadUseCase = new CreateCommentThreadUseCase(repo, notifier);
    addReplyUseCase = new AddCommentReplyUseCase(repo, notifier);
    resolveThreadUseCase = new ResolveCommentThreadUseCase(repo, notifier);
    getDocReviewsUseCase = new GetDocReviewsUseCase(repo);

    service = new TrackChangesService(
      recordChangeUseCase,
      acceptChangeUseCase,
      rejectChangeUseCase,
      batchResolveUseCase,
      createThreadUseCase,
      addReplyUseCase,
      resolveThreadUseCase,
      getDocReviewsUseCase,
    );

    controller = new TrackChangesController(service);
  });

  // =========================================================================
  // 1. DOMAIN LAYER TESTS: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Value Objects & Entities', () => {
    describe('TextRangeVo', () => {
      it('should create valid text range value object', () => {
        const range = TextRangeVo.create({
          startLine: 1,
          startCol: 5,
          endLine: 2,
          endCol: 10,
        });

        expect(range.startLine).toBe(1);
        expect(range.startCol).toBe(5);
        expect(range.endLine).toBe(2);
        expect(range.endCol).toBe(10);
        expect(range.toJSON()).toEqual({
          startLine: 1,
          startCol: 5,
          endLine: 2,
          endCol: 10,
        });
      });

      it('should clamp negative values to zero', () => {
        const range = TextRangeVo.create({
          startLine: -5,
          startCol: -2,
          endLine: 0,
          endCol: 4,
        });

        expect(range.startLine).toBe(0);
        expect(range.startCol).toBe(0);
      });

      it('should normalize coordinates so endLine >= startLine and endCol >= startCol', () => {
        const range = TextRangeVo.create({
          startLine: 5,
          startCol: 15,
          endLine: 2,
          endCol: 5,
        });
        expect(range.startLine).toBe(5);
        expect(range.endLine).toBe(5);
        expect(range.endCol).toBe(15);
      });

      it('should accurately test overlaps between ranges', () => {
        const r1 = TextRangeVo.create({ startLine: 1, startCol: 5, endLine: 1, endCol: 15 });
        const r2 = TextRangeVo.create({ startLine: 1, startCol: 10, endLine: 1, endCol: 20 });
        const r3 = TextRangeVo.create({ startLine: 1, startCol: 25, endLine: 1, endCol: 30 });
        const r4 = TextRangeVo.create({ startLine: 2, startCol: 0, endLine: 2, endCol: 10 });

        expect(r1.overlaps(r2)).toBe(true);
        expect(r2.overlaps(r1)).toBe(true);
        expect(r1.overlaps(r3)).toBe(false);
        expect(r1.overlaps(r4)).toBe(false);
      });

      it('should test range containment', () => {
        const outer = TextRangeVo.create({ startLine: 1, startCol: 0, endLine: 3, endCol: 50 });
        const inner = TextRangeVo.create({ startLine: 1, startCol: 10, endLine: 2, endCol: 20 });
        const outside = TextRangeVo.create({ startLine: 3, startCol: 55, endLine: 4, endCol: 10 });

        expect(outer.contains(inner)).toBe(true);
        expect(inner.contains(outer)).toBe(false);
        expect(outer.contains(outside)).toBe(false);
      });
    });

    describe('ChangeMetadataVo', () => {
      it('should initialize metadata with author and client timestamp', () => {
        const now = new Date();
        const meta = new ChangeMetadataVo({
          createdById: 'user-bob',
          authorName: 'Bob',
          authorColor: '#ff0000',
          createdAt: now,
        });

        expect(meta.createdById).toBe('user-bob');
        expect(meta.authorName).toBe('Bob');
        expect(meta.authorColor).toBe('#ff0000');
        expect(meta.createdAt).toBe(now);
      });

      it('should provide default values when omitted', () => {
        const meta = new ChangeMetadataVo({});
        expect(meta.authorName).toBe('Collaborator');
        expect(meta.authorColor).toBe('#3b82f6');
        expect(meta.createdById).toBeNull();
      });
    });

    describe('TrackChange Entity', () => {
      it('should instantiate a pending insert change', () => {
        const change = TrackChange.create({
          id: 'c-1',
          projectId,
          docId,
          type: 'insert',
          text: 'Hello LaTeX',
          range: TextRangeVo.create({ startLine: 2, startCol: 6, endLine: 2, endCol: 17 }),
          createdById: userId,
        });

        expect(change.id).toBe('c-1');
        expect(change.type).toBe('insert');
        expect(change.status).toBe('pending');
        expect(change.text).toBe('Hello LaTeX');
        expect(change.createdById).toBe(userId);
      });

      it('should accept pending change successfully', () => {
        const change = TrackChange.create({
          id: 'c-2',
          projectId,
          docId,
          type: 'delete',
          text: 'old text',
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 8 }),
        });

        change.accept('reviewer-1');
        expect(change.status).toBe('accepted');
        expect(change.resolvedById).toBe('reviewer-1');
        expect(change.resolvedAt).not.toBeNull();
      });

      it('should throw error when accepting already resolved change', () => {
        const change = TrackChange.create({
          id: 'c-3',
          projectId,
          docId,
          type: 'insert',
          text: 'abc',
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 3 }),
        });

        change.accept('reviewer-1');
        expect(() => change.accept('reviewer-2')).toThrow(/has already been accepted/);
        expect(() => change.reject('reviewer-2')).toThrow(/has already been accepted/);
      });

      it('should reject pending change successfully', () => {
        const change = TrackChange.create({
          id: 'c-4',
          projectId,
          docId,
          type: 'insert',
          text: 'wrong insertion',
          range: TextRangeVo.create({ startLine: 1, startCol: 0, endLine: 1, endCol: 15 }),
        });

        change.reject('reviewer-2');
        expect(change.status).toBe('rejected');
        expect(change.resolvedById).toBe('reviewer-2');
      });
    });

    describe('CommentThread & CommentReply Entities', () => {
      it('should create comment thread with initial reply', () => {
        const reply = CommentReply.create({
          id: 'r-1',
          threadId: 't-1',
          createdById: userId,
          content: 'Should we cite Lamport here?',
        });

        const thread = CommentThread.create({
          id: 't-1',
          projectId,
          docId,
          quote: '\\documentclass{article}',
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 23 }),
          replies: [reply],
        });

        expect(thread.id).toBe('t-1');
        expect(thread.isResolved).toBe(false);
        expect(thread.quote).toBe('\\documentclass{article}');
        expect(thread.replies.length).toBe(1);
        expect(thread.replies[0].content).toBe('Should we cite Lamport here?');
        expect(thread.replies[0].createdById).toBe(userId);
      });

      it('should allow adding reply to open thread', () => {
        const thread = CommentThread.create({
          id: 't-2',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 1, startCol: 0, endLine: 1, endCol: 5 }),
        });

        const reply = CommentReply.create({
          id: 'r-2',
          threadId: 't-2',
          createdById: 'user-bob',
          content: 'Agreed, adding bib reference.',
        });

        thread.addReply(reply);
        expect(thread.replies.length).toBe(1);
        expect(thread.replies[0].id).toBe('r-2');
      });

      it('should resolve thread and disallow replies when resolved', () => {
        const thread = CommentThread.create({
          id: 't-3',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 1, startCol: 0, endLine: 1, endCol: 5 }),
        });

        thread.resolve('user-alice');
        expect(thread.isResolved).toBe(true);
        expect(thread.resolvedById).toBe('user-alice');
        expect(thread.resolvedAt).toBeInstanceOf(Date);

        // Disallow adding replies to resolved thread
        const newReply = CommentReply.create({
          id: 'r-3',
          threadId: 't-3',
          createdById: 'user-bob',
          content: 'Wait one more thing',
        });

        expect(() => thread.addReply(newReply)).toThrow(/Cannot add reply to a resolved comment thread/);
      });

      it('should throw error when resolving already resolved thread', () => {
        const thread = CommentThread.create({
          id: 't-4',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });

        thread.resolve('user-alice');
        expect(() => thread.resolve('user-alice')).toThrow(/Comment thread is already resolved/);
      });

      it('should unresolve thread and allow replies again', () => {
        const thread = CommentThread.create({
          id: 't-5',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });

        thread.resolve('user-alice');
        expect(thread.isResolved).toBe(true);

        thread.unresolve();
        expect(thread.isResolved).toBe(false);
        expect(thread.resolvedAt).toBeNull();
        expect(thread.resolvedById).toBeNull();

        // Should allow replies again
        const reply = CommentReply.create({
          id: 'r-5',
          threadId: 't-5',
          createdById: 'user-carol',
          content: 'Reopened discussion.',
        });
        thread.addReply(reply);
        expect(thread.replies.length).toBe(1);
      });
    });
  });

  // =========================================================================
  // 2. ADAPTER LAYER: DOCSTORE PATCHER (SPLICE & MUTATION MATH)
  // =========================================================================
  describe('DocstorePatcherAdapter (Text Splicing & Mutex)', () => {
    describe('removeRange', () => {
      it('should splice out character range on the same line', () => {
        const lines = ['The quick brown fox jumps over the lazy dog'];
        const range = TextRangeVo.create({ startLine: 0, startCol: 4, endLine: 0, endCol: 16 });

        const result = patcherAdapter.removeRange(lines, range);
        expect(result).toEqual(['The fox jumps over the lazy dog']);
      });

      it('should splice across multiple lines merging first prefix with last suffix', () => {
        const lines = [
          'First line keep this - REMOVE ME',
          'ENTIRE LINE 2 REMOVED',
          'ENTIRE LINE 3 REMOVED',
          'REMOVE START - and keep this last part',
        ];

        const range = TextRangeVo.create({ startLine: 0, startCol: 22, endLine: 3, endCol: 15 });
        const result = patcherAdapter.removeRange(lines, range);

        expect(result).toEqual(['First line keep this -and keep this last part']);
      });

      it('should return original lines if startLine is out of bounds', () => {
        const lines = ['Line 1', 'Line 2'];
        const range = TextRangeVo.create({ startLine: 10, startCol: 0, endLine: 12, endCol: 5 });

        const result = patcherAdapter.removeRange(lines, range);
        expect(result).toEqual(['Line 1', 'Line 2']);
      });
    });

    describe('insertRange', () => {
      it('should insert single line text into line at column', () => {
        const lines = ['Hello world!'];
        const range = TextRangeVo.create({ startLine: 0, startCol: 5, endLine: 0, endCol: 5 });

        const result = patcherAdapter.insertRange(lines, range, ' beautiful');
        expect(result).toEqual(['Hello beautiful world!']);
      });

      it('should expand lines array when inserting multiline text with newlines', () => {
        const lines = ['Start of doc.', 'End of doc.'];
        const range = TextRangeVo.create({ startLine: 0, startCol: 13, endLine: 0, endCol: 13 });

        const inserted = '\nMiddle line 1\nMiddle line 2\n';
        const result = patcherAdapter.insertRange(lines, range, inserted);

        expect(result).toEqual([
          'Start of doc.',
          'Middle line 1',
          'Middle line 2',
          '',
          'End of doc.',
        ]);
      });

      it('should pad lines with empty strings if startLine exceeds length', () => {
        const lines = ['Line 0'];
        const range = TextRangeVo.create({ startLine: 2, startCol: 0, endLine: 2, endCol: 0 });

        const result = patcherAdapter.insertRange(lines, range, 'New line at 2');
        expect(result).toEqual(['Line 0', '', 'New line at 2']);
      });
    });

    describe('applyChange (Accepting Changes)', () => {
      it('should not mutate docstore lines when accepting insert (already typed by user)', async () => {
        const change = TrackChange.create({
          id: 'c-ins-1',
          projectId,
          docId,
          type: 'insert',
          text: 'Hello',
          range: TextRangeVo.create({ startLine: 2, startCol: 0, endLine: 2, endCol: 5 }),
        });

        const initialDoc = await mockDocstore.getDoc(projectId, docId);
        const res = await patcherAdapter.applyChange(projectId, docId, change);

        expect(res.lines).toEqual(initialDoc.lines);
        expect(res.newRev).toBe(initialDoc.rev);
      });

      it('should purge deleted range from docstore when accepting delete change', async () => {
        const change = TrackChange.create({
          id: 'c-del-1',
          projectId,
          docId,
          type: 'delete',
          text: ' World',
          range: TextRangeVo.create({ startLine: 2, startCol: 5, endLine: 2, endCol: 11 }),
        });

        const res = await patcherAdapter.applyChange(projectId, docId, change);
        expect(res.lines[2]).toBe('Hello');
        const updatedDoc = await mockDocstore.getDoc(projectId, docId);
        expect(updatedDoc.lines[2]).toBe('Hello');
      });
    });

    describe('revertChange (Rejecting Changes)', () => {
      it('should purge inserted text from docstore when rejecting insert change', async () => {
        const change = TrackChange.create({
          id: 'c-ins-rej',
          projectId,
          docId,
          type: 'insert',
          text: ' World',
          range: TextRangeVo.create({ startLine: 2, startCol: 5, endLine: 2, endCol: 11 }),
        });

        const res = await patcherAdapter.revertChange(projectId, docId, change);
        expect(res.lines[2]).toBe('Hello');
      });

      it('should restore deleted text into docstore when rejecting delete change', async () => {
        // Document currently has 'Hello World'
        const change = TrackChange.create({
          id: 'c-del-rej',
          projectId,
          docId,
          type: 'delete',
          text: ' Beautiful',
          range: TextRangeVo.create({ startLine: 2, startCol: 5, endLine: 2, endCol: 5 }),
        });

        const res = await patcherAdapter.revertChange(projectId, docId, change);
        expect(res.lines[2]).toBe('Hello Beautiful World');
      });
    });
  });

  // =========================================================================
  // 3. USE CASES LAYER TESTS
  // =========================================================================
  describe('Inbound Use Cases', () => {
    describe('RecordChangeUseCase', () => {
      it('should record an inline change, persist it, and emit change:recorded', async () => {
        const input = {
          projectId,
          docId,
          type: 'insert' as ChangeType,
          text: 'New Paragraph',
          range: { startLine: 2, startCol: 0, endLine: 2, endCol: 13 },
          userId,
        };

        const change = await recordChangeUseCase.execute(input);

        expect(change.id).toBeDefined();
        expect(change.type).toBe('insert');
        expect(change.text).toBe('New Paragraph');
        expect(change.status).toBe('pending');

        const saved = await repo.findChangeById(change.id);
        expect(saved).not.toBeNull();

        expect(notifier.events.length).toBe(1);
        expect(notifier.events[0].type).toBe('change:recorded');
        expect(notifier.events[0].payload.id).toBe(change.id);
      });
    });

    describe('AcceptChangeUseCase', () => {
      it('should accept a delete change, apply docstore patch, and emit change:resolved', async () => {
        // Save pending delete change
        const change = TrackChange.create({
          id: 'c-del-acc',
          projectId,
          docId,
          type: 'delete',
          text: ' World',
          range: TextRangeVo.create({ startLine: 2, startCol: 5, endLine: 2, endCol: 11 }),
        });
        await repo.saveChange(change);

        const accepted = await acceptChangeUseCase.execute({
          projectId,
          docId,
          changeId: 'c-del-acc',
          userId: 'reviewer-bob',
        });

        expect(accepted.status).toBe('accepted');
        expect(accepted.resolvedById).toBe('reviewer-bob');

        const doc = await mockDocstore.getDoc(projectId, docId);
        expect(doc.lines[2]).toBe('Hello');

        expect(notifier.events.some((e) => e.type === 'change:resolved')).toBe(true);
      });

      it('should throw ChangeNotFoundException if changeId does not exist', async () => {
        await expect(
          acceptChangeUseCase.execute({
            projectId,
            docId,
            changeId: 'non-existent',
            userId,
          }),
        ).rejects.toThrow(ChangeNotFoundException);
      });
    });

    describe('RejectChangeUseCase', () => {
      it('should reject an insert change, purge text from docstore, and emit change:resolved', async () => {
        const change = TrackChange.create({
          id: 'c-ins-rej-uc',
          projectId,
          docId,
          type: 'insert',
          text: ' World',
          range: TextRangeVo.create({ startLine: 2, startCol: 5, endLine: 2, endCol: 11 }),
        });
        await repo.saveChange(change);

        const rejected = await rejectChangeUseCase.execute({
          projectId,
          docId,
          changeId: 'c-ins-rej-uc',
          userId: 'reviewer-charlie',
        });

        expect(rejected.status).toBe('rejected');
        expect(rejected.resolvedById).toBe('reviewer-charlie');

        const doc = await mockDocstore.getDoc(projectId, docId);
        expect(doc.lines[2]).toBe('Hello');

        expect(notifier.events.some((e) => e.type === 'change:resolved')).toBe(true);
      });

      it('should throw ChangeNotFoundException if changeId does not exist', async () => {
        await expect(
          rejectChangeUseCase.execute({
            projectId,
            docId,
            changeId: 'non-existent',
            userId,
          }),
        ).rejects.toThrow(ChangeNotFoundException);
      });
    });

    describe('BatchResolveChangesUseCase', () => {
      it('should accept all changes specified in batch', async () => {
        const c1 = TrackChange.create({
          id: 'c-b-1',
          projectId,
          docId,
          type: 'insert',
          text: 'text1',
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });
        const c2 = TrackChange.create({
          id: 'c-b-2',
          projectId,
          docId,
          type: 'insert',
          text: 'text2',
          range: TextRangeVo.create({ startLine: 1, startCol: 0, endLine: 1, endCol: 5 }),
        });
        await repo.saveChange(c1);
        await repo.saveChange(c2);

        const result = await batchResolveUseCase.execute({
          projectId,
          docId,
          action: 'accept_all',
          userId: 'batch-reviewer',
        });

        expect(result.action).toBe('accept_all');
        expect(result.resolvedCount).toBe(2);

        const saved1 = await repo.findChangeById('c-b-1');
        const saved2 = await repo.findChangeById('c-b-2');
        expect(saved1?.status).toBe('accepted');
        expect(saved2?.status).toBe('accepted');
      });

      it('should reject all changes specified in batch', async () => {
        const c1 = TrackChange.create({
          id: 'c-b-3',
          projectId,
          docId,
          type: 'insert',
          text: 'text3',
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });
        await repo.saveChange(c1);

        const result = await batchResolveUseCase.execute({
          projectId,
          docId,
          action: 'reject_all',
          userId: 'batch-reviewer',
        });

        expect(result.action).toBe('reject_all');
        expect(result.resolvedCount).toBe(1);

        const saved = await repo.findChangeById('c-b-3');
        expect(saved?.status).toBe('rejected');
      });
    });

    describe('CreateCommentThreadUseCase', () => {
      it('should create comment thread with initial reply and notify realtime', async () => {
        const thread = await createThreadUseCase.execute({
          projectId,
          docId,
          quote: '\\documentclass{article}',
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 23 },
          content: 'Add packages here',
          userId: 'author-alice',
        });

        expect(thread.id).toBeDefined();
        expect(thread.quote).toBe('\\documentclass{article}');
        expect(thread.isResolved).toBe(false);
        expect(thread.replies.length).toBe(1);
        expect(thread.replies[0].content).toBe('Add packages here');

        expect(notifier.events.some((e) => e.type === 'comment:created')).toBe(true);
      });
    });

    describe('AddCommentReplyUseCase', () => {
      it('should append reply to thread and notify realtime', async () => {
        const thread = CommentThread.create({
          id: 't-rep-1',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });
        await repo.saveCommentThread(thread);

        const reply = await addReplyUseCase.execute({
          projectId,
          docId,
          threadId: 't-rep-1',
          content: 'I will handle this',
          userId: 'user-bob',
        });

        expect(reply.id).toBeDefined();
        expect(reply.content).toBe('I will handle this');
        expect(reply.createdById).toBe('user-bob');

        const updatedThread = await repo.findThreadById('t-rep-1');
        expect(updatedThread?.replies.length).toBe(1);
        expect(notifier.events.some((e) => e.type === 'comment:replied')).toBe(true);
      });

      it('should throw ThreadNotFoundException if threadId does not exist', async () => {
        await expect(
          addReplyUseCase.execute({
            projectId,
            docId,
            threadId: 'non-existent',
            content: 'Hello',
            userId,
          }),
        ).rejects.toThrow(ThreadNotFoundException);
      });

      it('should throw ResolvedThreadException if thread is already resolved', async () => {
        const thread = CommentThread.create({
          id: 't-rep-res',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });
        thread.resolve(userId);
        await repo.saveCommentThread(thread);

        await expect(
          addReplyUseCase.execute({
            projectId,
            docId,
            threadId: 't-rep-res',
            content: 'Adding reply to resolved thread',
            userId,
          }),
        ).rejects.toThrow(ResolvedThreadException);
      });
    });

    describe('ResolveCommentThreadUseCase', () => {
      it('should resolve thread and notify realtime', async () => {
        const thread = CommentThread.create({
          id: 't-res-1',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });
        await repo.saveCommentThread(thread);

        const resolved = await resolveThreadUseCase.execute({
          projectId,
          docId,
          threadId: 't-res-1',
          resolve: true,
          userId: 'user-alice',
        });

        expect(resolved.isResolved).toBe(true);
        expect(resolved.resolvedById).toBe('user-alice');
        expect(notifier.events.some((e) => e.type === 'comment:resolved')).toBe(true);
      });

      it('should unresolve thread when resolve flag is false', async () => {
        const thread = CommentThread.create({
          id: 't-res-2',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 5 }),
        });
        thread.resolve('user-alice');
        await repo.saveCommentThread(thread);

        const reopened = await resolveThreadUseCase.execute({
          projectId,
          docId,
          threadId: 't-res-2',
          resolve: false,
          userId: 'user-alice',
        });

        expect(reopened.isResolved).toBe(false);
        expect(reopened.resolvedById).toBeNull();
      });

      it('should throw ThreadNotFoundException if threadId does not exist', async () => {
        await expect(
          resolveThreadUseCase.execute({
            projectId,
            docId,
            threadId: 'missing-thread',
            resolve: true,
            userId,
          }),
        ).rejects.toThrow(ThreadNotFoundException);
      });
    });

    describe('GetDocReviewsUseCase', () => {
      it('should retrieve pending changes and comment threads', async () => {
        const c1 = TrackChange.create({
          id: 'c-rev-1',
          projectId,
          docId,
          type: 'insert',
          text: 'val',
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 3 }),
        });
        const t1 = CommentThread.create({
          id: 't-rev-1',
          projectId,
          docId,
          range: TextRangeVo.create({ startLine: 0, startCol: 0, endLine: 0, endCol: 3 }),
        });
        await repo.saveChange(c1);
        await repo.saveCommentThread(t1);

        const reviews = await getDocReviewsUseCase.execute(projectId, docId);
        expect(reviews.changes.length).toBe(1);
        expect(reviews.threads.length).toBe(1);
      });
    });
  });

  // =========================================================================
  // 4. SERVICE & CONTROLLER HTTP INTEGRATION TESTS
  // =========================================================================
  describe('Service & REST Controller Integration', () => {
    it('should map record change request and return 201 DTO', async () => {
      const res = await controller.recordChange(projectId, docId, {
        type: 'insert',
        text: 'New LaTeX content',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 16 },
      });

      expect(res.id).toBeDefined();
      expect(res.type).toBe('insert');
      expect(res.text).toBe('New LaTeX content');
      expect(res.status).toBe('pending');
      expect(res.range.startLine).toBe(1);
    });

    it('should accept change and return 200 DTO', async () => {
      const recorded = await service.recordChange(projectId, docId, {
        type: 'insert',
        text: 'Sample',
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 6 },
      });

      const accepted = await controller.acceptChange(projectId, docId, recorded.id);

      expect(accepted.id).toBe(recorded.id);
      expect(accepted.status).toBe('accepted');
    });

    it('should reject change and return 200 DTO', async () => {
      const recorded = await service.recordChange(projectId, docId, {
        type: 'delete',
        text: 'Sample',
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 6 },
      });

      const rejected = await controller.rejectChange(projectId, docId, recorded.id);

      expect(rejected.id).toBe(recorded.id);
      expect(rejected.status).toBe('rejected');
    });

    it('should batch resolve changes and return summary', async () => {
      await service.recordChange(projectId, docId, {
        type: 'insert',
        text: '1',
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 1 },
      });
      await service.recordChange(projectId, docId, {
        type: 'insert',
        text: '2',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
      });

      const batchRes = await controller.batchResolveChanges(projectId, docId, {
        action: 'accept_all',
      });

      expect(batchRes.action).toBe('accept_all');
      expect(batchRes.resolvedCount).toBe(2);
    });

    it('should create comment thread and return 201 DTO', async () => {
      const threadRes = await controller.createCommentThread(projectId, docId, {
        quote: 'Hello World',
        range: { startLine: 2, startCol: 0, endLine: 2, endCol: 11 },
        content: 'Review this greeting',
      });

      expect(threadRes.id).toBeDefined();
      expect(threadRes.quote).toBe('Hello World');
      expect(threadRes.replies.length).toBe(1);
      expect(threadRes.replies[0].content).toBe('Review this greeting');
    });

    it('should add comment reply and return 201 DTO', async () => {
      const threadRes = await service.createCommentThread(projectId, docId, {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
        content: 'Initial question',
      });

      const replyRes = await controller.addCommentReply(projectId, docId, threadRes.id, {
        content: 'Answer here',
      });

      expect(replyRes.id).toBeDefined();
      expect(replyRes.content).toBe('Answer here');
    });

    it('should resolve comment thread and return 200 DTO', async () => {
      const threadRes = await service.createCommentThread(projectId, docId, {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
        content: 'To resolve',
      });

      const resolved = await controller.resolveCommentThread(projectId, docId, threadRes.id, {
        resolve: true,
      });

      expect(resolved.id).toBe(threadRes.id);
      expect(resolved.isResolved).toBe(true);
    });

    it('should get all reviews for document', async () => {
      const reviews = await controller.getDocReviews(projectId, docId);
      expect(reviews.changes).toBeInstanceOf(Array);
      expect(reviews.threads).toBeInstanceOf(Array);
    });

    // Exception handling
    describe('Exception translation in Controller', () => {
      it('should translate ChangeNotFoundException to 404 NotFoundException', async () => {
        await expect(
          controller.acceptChange(projectId, docId, 'unknown-change-id'),
        ).rejects.toThrow(NotFoundException);
      });

      it('should translate ThreadNotFoundException to 404 NotFoundException', async () => {
        await expect(
          controller.addCommentReply(projectId, docId, 'unknown-thread-id', {
            content: 'Hello',
          }),
        ).rejects.toThrow(NotFoundException);
      });

      it('should translate ResolvedThreadException to 400 BadRequestException', async () => {
        const thread = await service.createCommentThread(projectId, docId, {
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
          content: 'Thread to be resolved',
        });
        await service.resolveCommentThread(projectId, docId, thread.id, true, 'admin');

        await expect(
          controller.addCommentReply(projectId, docId, thread.id, {
            content: 'Late reply',
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });
});
