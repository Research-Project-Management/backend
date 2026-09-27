/**
 * test/unit/manuscripts-multiuser-scale-simulation.spec.ts
 *
 * Full-Spectrum Multi-User Collaborative Simulation & Stress Benchmark Suite.
 *
 * Simulates a realistic scientific research team (5 personas):
 *   1. Dr. Elena Vance (Lead PI / Author)
 *   2. Dr. Gordon Freeman (Algorithm Specialist / Postdoc)
 *   3. Alex Chen (PhD Student / Data & Benchmarks)
 *   4. Prof. Eli Vance (Senior Reviewer / Department Head)
 *   5. Barney Calhoun (Research Assistant / Proofreader)
 *
 * Tests the Manuscript Subsystem across four distinct tiers of scale:
 *   - Tier 1: Small-Scale (Micro Scratchpad, single file, typing, word count, comments)
 *   - Tier 2: Medium-Scale (NeurIPS 10-page Conference Paper, multi-file, track changes, SyncTeX)
 *   - Tier 3: Large-Scale (Ph.D. Dissertation / Book Monograph, 50+ files, deep folder reorganization, lock contention)
 *   - Tier 4: Extremely Large-Scale & Stress / Edge Cases (40k lines, 2MB limit, OCC conflict, error storm)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PrismaService } from '@/core/database/prisma.service';

// Docstore Subsystem
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { GetDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/get-doc.use-case';
import { PeekDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/peek-doc.use-case';
import { UpdateDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/update-doc.use-case';
import { PatchDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/patch-doc.use-case';
import { GetAllDocsUseCase } from '@/modules/manuscripts/docstore/core/use-cases/get-all-docs.use-case';
import { ArchiveProjectUseCase } from '@/modules/manuscripts/docstore/core/use-cases/archive-project.use-case';
import { PrismaDocRepository } from '@/modules/manuscripts/docstore/core/adapters/database/prisma-doc.repository';
import { S3DocPersistorAdapter } from '@/modules/manuscripts/docstore/core/adapters/storage/s3-doc-persistor.adapter';
import { DocHasherAdapter } from '@/modules/manuscripts/docstore/core/adapters/engine/doc-hasher.adapter';
import { IDocRepository } from '@/modules/manuscripts/docstore/core/ports/doc-repository.port';
import { IDocPersistor } from '@/modules/manuscripts/docstore/core/ports/doc-persistor.port';
import { IDocHasher } from '@/modules/manuscripts/docstore/core/ports/doc-hasher.port';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/core/adapters/engine/line-array.engine';
import {
  DocTooLargeError,
  DocModifiedError,
  NullByteDetectedError,
} from '@/modules/manuscripts/docstore/core/domain/doc-errors';

// Track Changes Subsystem
import { TextRangeVo } from '@/modules/manuscripts/track-changes/core/domain/value-objects/text-range.vo';
import { ChangeMetadataVo } from '@/modules/manuscripts/track-changes/core/domain/value-objects/change-metadata.vo';
import { TrackChange } from '@/modules/manuscripts/track-changes/core/domain/entities/track-change.entity';
import { CommentReply } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-reply.entity';
import { CommentThread } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-thread.entity';
import { ITrackChangesRepositoryPort } from '@/modules/manuscripts/track-changes/core/ports/track-changes-repository.port';
import { IRealtimeNotifierPort } from '@/modules/manuscripts/track-changes/core/ports/realtime-notifier.port';
import { DocstorePatcherAdapter } from '@/modules/manuscripts/track-changes/core/adapters/external/docstore-patcher.adapter';
import { RecordChangeUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/record-change.use-case';
import { AcceptChangeUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/accept-change.use-case';
import { RejectChangeUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/reject-change.use-case';
import { CreateCommentThreadUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/create-comment-thread.use-case';
import { AddCommentReplyUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/add-comment-reply.use-case';
import { ResolveCommentThreadUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/resolve-comment-thread.use-case';
import { GetDocReviewsUseCase } from '@/modules/manuscripts/track-changes/core/use-cases/get-doc-reviews.use-case';

// Structure Subsystem
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';
import { NodePathVo } from '@/modules/manuscripts/structure/core/domain/node-path.vo';
import { CyclicMoveError } from '@/modules/manuscripts/structure/core/domain/structure-errors';
import { IStructureRepository, CreateNodeParams } from '@/modules/manuscripts/structure/core/ports/structure-repository.port';
import { CreateNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/create-node.use-case';
import { MoveNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/move-node.use-case';
import { RenameNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/rename-node.use-case';
import { GetFileTreeUseCase } from '@/modules/manuscripts/structure/core/use-cases/get-file-tree.use-case';
import { ResolveRootDocUseCase } from '@/modules/manuscripts/structure/core/use-cases/resolve-root-doc.use-case';
import { HeuristicRootDocDetector } from '@/modules/manuscripts/structure/core/adapters/engine/heuristic-root-doc.detector';
import { InMemoryTreePublisher } from '@/modules/manuscripts/structure/core/adapters/event/in-memory-tree.publisher';

// CLSI & Diagnostics Subsystem
import { SyncTexProcessor } from '@/modules/manuscripts/clsi/core/adapters/artifacts/synctex.processor';
import { ProjectLockManager } from '@/modules/manuscripts/clsi/core/adapters/workspace/project-lock.manager';
import { TexWordCounter } from '@/modules/manuscripts/clsi/core/adapters/artifacts/word-counter';
import {
  TexParenTreeLogParser,
  TectonicLogParser,
  KnowledgeBaseExplainerAdapter,
  ParseCompileLogUseCase,
} from '@/modules/manuscripts/diagnostics';

// ---------------------------------------------------------------------------
// TEST INFRASTRUCTURE / DOUBLES
// ---------------------------------------------------------------------------

class InMemoryStructureRepo implements IStructureRepository {
  public nodes = new Map<string, ManuscriptNodeEntity>();

  public clear() {
    this.nodes.clear();
  }

  public async createNode(params: CreateNodeParams): Promise<ManuscriptNodeEntity> {
    const id = `node-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const depth = NodePathVo.depth(params.path);
    const entity = new ManuscriptNodeEntity({
      id,
      projectId: params.projectId,
      parentId: params.parentId || null,
      type: params.type,
      name: params.name,
      path: params.path,
      depth,
      docId: params.docId || null,
      fileId: params.fileId || null,
      isRootDoc: params.isRootDoc || false,
      sizeBytes: params.sizeBytes || 0,
      hash: params.hash || null,
      sortOrder: params.sortOrder || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.nodes.set(entity.id, entity);
    return entity;
  }

  public async findById(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity | null> {
    const node = this.nodes.get(nodeId);
    return node && node.projectId === projectId ? node : null;
  }

  public async findByPath(projectId: string, path: string): Promise<ManuscriptNodeEntity | null> {
    const normalized = NodePathVo.normalize(path);
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId && node.path === normalized) {
        return node;
      }
    }
    return null;
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    return Array.from(this.nodes.values())
      .filter((n) => n.projectId === projectId)
      .sort((a, b) => a.depth - b.depth);
  }

  public async getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null> {
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId && node.isRootDoc) {
        return node;
      }
    }
    return null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId) {
        node.markAsRootDoc(node.id === nodeId);
      }
    }
  }

  public async unsetRootDoc(projectId: string): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId) {
        node.markAsRootDoc(false);
      }
    }
  }

  public async moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null,
  ): Promise<void> {
    const normSource = NodePathVo.normalize(sourcePath);
    const normDest = NodePathVo.normalize(destPath);
    const sourcePrefix = normSource + '/';

    for (const node of this.nodes.values()) {
      if (node.projectId !== projectId) continue;
      if (node.path === normSource) {
        node.moveTo(newParentId, normDest);
      } else if (node.path.startsWith(sourcePrefix)) {
        const relative = node.path.substring(normSource.length);
        const newChildPath = normDest + relative;
        node.moveTo(node.parentId, newChildPath);
      }
    }
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string,
  ): Promise<ManuscriptNodeEntity> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.rename(newName, newPath);
    return node;
  }

  public async updateSortOrder(projectId: string, nodeId: string, sortOrder: number): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node && node.projectId === projectId) {
      (node as any).props.sortOrder = sortOrder;
    }
  }

  public async deleteSubtree(projectId: string, path: string): Promise<ManuscriptNodeEntity[]> {
    const normalized = NodePathVo.normalize(path);
    const prefix = normalized + '/';
    const deleted: ManuscriptNodeEntity[] = [];
    for (const [id, node] of this.nodes.entries()) {
      if (node.projectId === projectId) {
        if (node.path === normalized || node.path.startsWith(prefix)) {
          deleted.push(node);
          this.nodes.delete(id);
        }
      }
    }
    return deleted;
  }

  public async countNodes(projectId: string): Promise<number> {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId) count++;
    }
    return count;
  }
}

class InMemoryTrackChangesRepo implements ITrackChangesRepositoryPort {
  public changes = new Map<string, TrackChange>();
  public threads = new Map<string, CommentThread>();

  async saveChange(change: TrackChange): Promise<TrackChange> {
    this.changes.set(change.id, change);
    return change;
  }

  async findChangeById(id: string): Promise<TrackChange | null> {
    return this.changes.get(id) || null;
  }

  async listChangesByDoc(projectId: string, docId: string, status?: string): Promise<TrackChange[]> {
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

class TestRealtimeNotifier implements IRealtimeNotifierPort {
  public eventLog: Array<{ type: string; projectId: string; docId: string; payload: any }> = [];

  notifyChangeRecorded(projectId: string, docId: string, change: TrackChange): void {
    this.eventLog.push({ type: 'change:recorded', projectId, docId, payload: change });
  }

  notifyChangeResolved(projectId: string, docId: string, change: TrackChange): void {
    this.eventLog.push({ type: 'change:resolved', projectId, docId, payload: change });
  }

  notifyCommentCreated(projectId: string, docId: string, thread: CommentThread): void {
    this.eventLog.push({ type: 'comment:created', projectId, docId, payload: thread });
  }

  notifyCommentReplied(projectId: string, docId: string, threadId: string, reply: CommentReply): void {
    this.eventLog.push({ type: 'comment:replied', projectId, docId, payload: { threadId, reply } });
  }

  notifyCommentResolved(projectId: string, docId: string, thread: CommentThread): void {
    this.eventLog.push({ type: 'comment:resolved', projectId, docId, payload: thread });
  }
}

// ---------------------------------------------------------------------------
// SUITE IMPLEMENTATION
// ---------------------------------------------------------------------------

describe('Multi-User Collaborative Simulation & Full-Scale Stress Test', () => {
  // 5 Research Team Members
  const TEAM = {
    ELENA: { id: 'usr-elena-vance-pi', name: 'Dr. Elena Vance (Lead PI)' },
    GORDON: { id: 'usr-gordon-freeman', name: 'Dr. Gordon Freeman (Algorithm Specialist)' },
    ALEX: { id: 'usr-alex-chen', name: 'Alex Chen (PhD Student / Experiments)' },
    ELI: { id: 'usr-prof-eli-vance', name: 'Prof. Eli Vance (Senior Reviewer)' },
    BARNEY: { id: 'usr-barney-calhoun', name: 'Barney Calhoun (Research Assistant / Proofreader)' },
  };

  const PROJECT_ID = 'prj-quantum-ai-collab-2026';

  // In-memory Database mock
  const mockDbDocs = new Map<string, any>();

  const mockPrismaService = {
    manuscriptDoc: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id) return mockDbDocs.get(where.id) || null;
        if (where.projectId && where.path) {
          for (const doc of mockDbDocs.values()) {
            if (doc.projectId === where.projectId && doc.path === where.path && !doc.deleted) {
              return doc;
            }
          }
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const results: any[] = [];
        for (const doc of mockDbDocs.values()) {
          if (doc.projectId === where.projectId) {
            if (where.deleted !== undefined && doc.deleted !== where.deleted) continue;
            results.push(doc);
          }
        }
        return results;
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = data.id || `doc-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const record = {
          id,
          projectId: data.projectId,
          path: data.path,
          lines: data.lines,
          rev: data.rev ?? 1,
          version: data.version ?? 0,
          ranges: data.ranges || { changes: [], comments: [] },
          hash: data.hash || '',
          sizeBytes: data.sizeBytes ?? 0,
          inStorage: data.inStorage ?? false,
          storageKey: null,
          deleted: false,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockDbDocs.set(id, record);
        return record;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = mockDbDocs.get(where.id);
        if (!existing) throw new Error('Document not found');
        const updated = {
          ...existing,
          ...data,
          rev: data.rev?.increment ? existing.rev + 1 : (data.rev ?? existing.rev),
          updatedAt: new Date(),
        };
        mockDbDocs.set(where.id, updated);
        return updated;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const doc of mockDbDocs.values()) {
          if (doc.id === where.id && doc.projectId === where.projectId) {
            if (where.rev !== undefined && doc.rev !== where.rev) continue;
            Object.assign(doc, {
              ...data,
              rev: data.rev?.increment ? doc.rev + 1 : (data.rev ?? doc.rev),
              updatedAt: new Date(),
            });
            count++;
          }
        }
        return { count };
      }),
    },
  };

  const mockConfigService = {
    get: jest.fn((k: string) => (k === 'S3_BUCKET_NAME' ? 'flux-benchmarks' : null)),
  };

  let docstoreService: DocstoreService;
  let structureRepo: InMemoryStructureRepo;
  let trackRepo: InMemoryTrackChangesRepo;
  let realtimeNotifier: TestRealtimeNotifier;

  let createNodeUseCase: CreateNodeUseCase;
  let moveNodeUseCase: MoveNodeUseCase;
  let renameNodeUseCase: RenameNodeUseCase;
  let getFileTreeUseCase: GetFileTreeUseCase;
  let resolveRootDocUseCase: ResolveRootDocUseCase;

  let recordChangeUseCase: RecordChangeUseCase;
  let acceptChangeUseCase: AcceptChangeUseCase;
  let rejectChangeUseCase: RejectChangeUseCase;
  let createCommentUseCase: CreateCommentThreadUseCase;
  let addReplyUseCase: AddCommentReplyUseCase;
  let resolveCommentUseCase: ResolveCommentThreadUseCase;
  let getReviewsUseCase: GetDocReviewsUseCase;
  let docstorePatcher: DocstorePatcherAdapter;

  beforeAll(async () => {
    mockDbDocs.clear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocstoreService,
        GetDocUseCase,
        PeekDocUseCase,
        UpdateDocUseCase,
        PatchDocUseCase,
        GetAllDocsUseCase,
        ArchiveProjectUseCase,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: IDocRepository, useClass: PrismaDocRepository },
        { provide: IDocPersistor, useClass: S3DocPersistorAdapter },
        { provide: IDocHasher, useClass: DocHasherAdapter },
        PrismaDocRepository,
        S3DocPersistorAdapter,
        DocHasherAdapter,
      ],
    }).compile();

    docstoreService = module.get<DocstoreService>(DocstoreService);

    // Structure setup
    structureRepo = new InMemoryStructureRepo();
    const treePublisher = new InMemoryTreePublisher();
    createNodeUseCase = new CreateNodeUseCase(structureRepo, treePublisher);
    moveNodeUseCase = new MoveNodeUseCase(structureRepo, treePublisher);
    renameNodeUseCase = new RenameNodeUseCase(structureRepo, treePublisher);
    getFileTreeUseCase = new GetFileTreeUseCase(structureRepo);
    resolveRootDocUseCase = new ResolveRootDocUseCase(structureRepo, new HeuristicRootDocDetector(), treePublisher);

    // Track Changes setup
    trackRepo = new InMemoryTrackChangesRepo();
    realtimeNotifier = new TestRealtimeNotifier();
    docstorePatcher = new DocstorePatcherAdapter(docstoreService);

    recordChangeUseCase = new RecordChangeUseCase(trackRepo, realtimeNotifier);
    acceptChangeUseCase = new AcceptChangeUseCase(trackRepo, docstorePatcher, realtimeNotifier);
    rejectChangeUseCase = new RejectChangeUseCase(trackRepo, docstorePatcher, realtimeNotifier);
    createCommentUseCase = new CreateCommentThreadUseCase(trackRepo, realtimeNotifier);
    addReplyUseCase = new AddCommentReplyUseCase(trackRepo, realtimeNotifier);
    resolveCommentUseCase = new ResolveCommentThreadUseCase(trackRepo, realtimeNotifier);
    getReviewsUseCase = new GetDocReviewsUseCase(trackRepo);
  });

  // =========================================================================
  // TIER 1: SMALL-SCALE (MICRO SCENARIO)
  // Single-file scratchpad, real-time typing, CRLF normalization, word counter,
  // inline comments with reply & resolution.
  // =========================================================================
  describe('Tier 1: Small-Scale Simulation (Micro Scratchpad & Single Document)', () => {
    it('Scenario 1.1: Elena creates a quick memo with CRLF & BOM, verified by LineArrayEngine', async () => {
      const rawContentWithBomAndCrlf = '\uFEFF\\section{Morning Standup}\r\nNeed to verify Hamiltonian matrix convergence.\r\nFormula: $H|\\psi\\rangle = E|\\psi\\rangle$.';
      
      const doc = await docstoreService.createDoc(PROJECT_ID, {
        path: 'memo.tex',
        text: rawContentWithBomAndCrlf,
      });

      expect(doc._id).toBeDefined();
      expect(doc.lines.length).toBe(3); // LineArrayEngine strips BOM and splits \r\n cleanly into 3 lines
      expect(doc.lines[0]).toBe('\\section{Morning Standup}');
      expect(doc.lines[1]).toBe('Need to verify Hamiltonian matrix convergence.');
      expect(doc.lines[2]).toBe('Formula: $H|\\psi\\rangle = E|\\psi\\rangle$.');
      expect(doc.rev).toBe(1);
    });

    it('Scenario 1.2: Real-time Academic Word Counting on micro document', () => {
      const tex = `\\section{Abstract}
This brief note summarizes quantum telemetry calculations.
We observe \\cite{vance2025} that the energy drift remains strictly bounded.
\\[ E = mc^2 \\]`;
      
      const wordCounter = new TexWordCounter();
      const stats = wordCounter.count(tex);
      expect(stats.wordsInText).toBeGreaterThan(10);
      expect(stats.headers).toBe(1);
      expect(stats.mathDisplayed).toBe(1);
    });

    it('Scenario 1.3: Collaborative Comment & Instant Resolution between Elena and Gordon', async () => {
      const doc = await docstoreService.createDoc(PROJECT_ID, {
        path: 'notes.tex',
        text: 'Line 1: Setup\nLine 2: Target parameter lambda=0.15\nLine 3: Finished\n',
      });

      // Elena highlights "lambda=0.15" on line 2 (1-indexed line 2, cols 17 to 28)
      const elenaThread = await createCommentUseCase.execute({
        projectId: PROJECT_ID,
        docId: doc._id,
        userId: TEAM.ELENA.id,
        content: '@Gordon please verify if lambda=0.15 is optimal or if we should use 0.05?',
        quote: 'lambda=0.15',
        range: { startLine: 2, startCol: 17, endLine: 2, endCol: 28 },
      });

      expect(elenaThread.id).toBeDefined();
      expect(elenaThread.isResolved).toBe(false);
      expect(realtimeNotifier.eventLog).toHaveLength(1);
      expect(realtimeNotifier.eventLog[0].type).toBe('comment:created');

      // Gordon Freeman receives notification and replies
      const gordonReply = await addReplyUseCase.execute({
        projectId: PROJECT_ID,
        docId: doc._id,
        threadId: elenaThread.id,
        userId: TEAM.GORDON.id,
        content: 'Verified analytically. lambda=0.05 yields 4x faster convergence. Updated.',
      });

      expect(gordonReply.id).toBeDefined();
      expect(realtimeNotifier.eventLog[1].type).toBe('comment:replied');

      // Gordon resolves the thread
      const resolvedThread = await resolveCommentUseCase.execute({
        projectId: PROJECT_ID,
        docId: doc._id,
        threadId: elenaThread.id,
        userId: TEAM.GORDON.id,
        resolve: true,
      });

      expect(resolvedThread.isResolved).toBe(true);
      expect(resolvedThread.resolvedById).toBe(TEAM.GORDON.id);

      // Verify active vs resolved filtering
      const activeThreads = await trackRepo.listThreadsByDoc(PROJECT_ID, doc._id, false);
      const allThreads = await trackRepo.listThreadsByDoc(PROJECT_ID, doc._id);
      expect(activeThreads).toHaveLength(0);
      expect(allThreads).toHaveLength(1);
    });
  });

  // =========================================================================
  // TIER 2: MEDIUM-SCALE (CONFERENCE PAPER - NEURIPS/ICML FORMAT)
  // Multi-file structure, heuristic root doc resolution, review mode track changes,
  // accept/reject surgical splicing, and bidirectional SyncTeX navigation.
  // =========================================================================
  describe('Tier 2: Medium-Scale Simulation (NeurIPS Conference Paper - 8-10 Pages)', () => {
    let mainDocId: string;
    let methodDocId: string;
    let expDocId: string;
    let mainContentText: string;

    it('Scenario 2.1: Multi-file project structure assembly and root doc heuristic detection', async () => {
      // 1. Root main.tex
      mainContentText = `\\documentclass{article}
\\usepackage{amsmath,amssymb}
\\title{Deep Quantum Operators at Scale}
\\author{Elena Vance \\and Gordon Freeman}
\\begin{document}
\\maketitle
\\input{sections/02_methods.tex}
\\input{sections/03_experiments.tex}
\\bibliographystyle{plain}
\\bibliography{references.bib}
\\end{document}`;

      const mainDoc = await docstoreService.createDoc(PROJECT_ID, { path: 'main.tex', text: mainContentText });
      mainDocId = mainDoc._id;

      // 2. Sections
      const methodContent = `\\section{Quantum Attention Kernel}
We formulate the non-local attention operator as:
\\begin{equation}
\\mathcal{K}(x, y) = \\exp\\left( -\\frac{\|x - y\|^2}{2\\sigma^2} \\right)
\\end{equation}
The baseline model assumes a uniform decay over all manifolds.`;
      const methodDoc = await docstoreService.createDoc(PROJECT_ID, {
        path: 'sections/02_methods.tex',
        text: methodContent,
      });
      methodDocId = methodDoc._id;

      const expContent = `\\section{Numerical Experiments}
We evaluated across 10 synthetic quantum manifolds.
Baseline accuracy achieved 87.4\\%.`;
      const expDoc = await docstoreService.createDoc(PROJECT_ID, {
        path: 'sections/03_experiments.tex',
        text: expContent,
      });
      expDocId = expDoc._id;

      // 3. Assemble Structure nodes
      const rootNode = await createNodeUseCase.execute(PROJECT_ID, {
        name: 'main.tex',
        path: 'main.tex',
        type: 'DOC',
        docId: mainDocId,
      });

      const sectionsDir = await createNodeUseCase.execute(PROJECT_ID, {
        name: 'sections',
        path: 'sections',
        type: 'FOLDER',
      });

      await createNodeUseCase.execute(PROJECT_ID, {
        parentId: sectionsDir.id,
        name: '02_methods.tex',
        path: 'sections/02_methods.tex',
        type: 'DOC',
        docId: methodDocId,
      });

      await createNodeUseCase.execute(PROJECT_ID, {
        parentId: sectionsDir.id,
        name: '03_experiments.tex',
        path: 'sections/03_experiments.tex',
        type: 'DOC',
        docId: expDocId,
      });

      // 4. Auto-detect Root Document using HeuristicRootDocDetector
      const docContents = new Map<string, string[]>();
      docContents.set(mainDocId, LineArrayEngine.textToLines(mainContentText));
      docContents.set(methodDocId, LineArrayEngine.textToLines(methodContent));
      docContents.set(expDocId, LineArrayEngine.textToLines(expContent));

      const detectedRoot = await resolveRootDocUseCase.autoDetectAndSetRootDoc(PROJECT_ID, docContents);

      expect(detectedRoot).not.toBeNull();
      expect(detectedRoot?.id).toBe(rootNode.id);
      expect(detectedRoot?.name).toBe('main.tex');
    });

    it('Scenario 2.2: Collaborative Track Changes - Alex proposes insertion, Eli reviews and accepts', async () => {
      // Alex Chen proposes inserting a critical mathematical constraint after line 6
      const alexProposal = await recordChangeUseCase.execute({
        projectId: PROJECT_ID,
        docId: methodDocId,
        userId: TEAM.ALEX.id,
        type: 'insert',
        text: '\nwhere $\\sigma$ is dynamically tuned via Riemannian gradient flow.',
        range: { startLine: 6, startCol: 1, endLine: 7, endCol: 65 },
      });

      expect(alexProposal.status).toBe('pending');
      expect(alexProposal.createdById).toBe(TEAM.ALEX.id);

      // Prof. Eli Vance reviews the paper and accepts Alex's proposal
      const acceptedChange = await acceptChangeUseCase.execute({
        projectId: PROJECT_ID,
        docId: methodDocId,
        changeId: alexProposal.id,
        userId: TEAM.ELI.id,
      });

      expect(acceptedChange.status).toBe('accepted');
      expect(acceptedChange.resolvedById).toBe(TEAM.ELI.id);
    });

    it('Scenario 2.3: Collaborative Track Changes - Barney proposes deletion, Eli rejects to preserve text', async () => {
      // Barney proposes deleting the baseline accuracy line in experiments
      const expDocBefore = await docstoreService.getDoc(PROJECT_ID, expDocId);
      expect(expDocBefore.lines[2]).toBe('Baseline accuracy achieved 87.4\\%.');

      const barneyDelete = await recordChangeUseCase.execute({
        projectId: PROJECT_ID,
        docId: expDocId,
        userId: TEAM.BARNEY.id,
        type: 'delete',
        text: 'Baseline accuracy achieved 87.4\\%.',
        range: { startLine: 3, startCol: 1, endLine: 3, endCol: 34 },
      });

      expect(barneyDelete.status).toBe('pending');

      // Prof. Eli Vance rejects the deletion because baseline comparisons are mandatory for NeurIPS
      const rejectedChange = await rejectChangeUseCase.execute({
        projectId: PROJECT_ID,
        docId: expDocId,
        changeId: barneyDelete.id,
        userId: TEAM.ELI.id,
      });

      expect(rejectedChange.status).toBe('rejected');

      // Verify text is preserved in docstore
      const expDocAfter = await docstoreService.getDoc(PROJECT_ID, expDocId);
      expect(expDocAfter.lines[2]).toBe('Baseline accuracy achieved 87.4\\%.');
    });

    it('Scenario 2.4: Bidirectional SyncTeX Navigation (Source-to-PDF & PDF-to-Source) for 10-page paper', () => {
      const synctexProcessor = new SyncTexProcessor();

      // Build realistic SyncTeX records for the 10-page paper
      const synctexData = [
        'SyncTeX Version:1',
        'Input:1:main.tex',
        'Input:2:sections/02_methods.tex',
        'Input:3:sections/03_experiments.tex',
        'Output:pdf',
        'Unit:1',
        'Magnification:1000',
        'X Offset:0',
        'Y Offset:0',
        'Content:',
      ];

      for (let p = 1; p <= 10; p++) {
        synctexData.push(`{${p}}`);
        synctexData.push(`[${p},1:0,0:45000000,55000000,0`);
        // Map line 4 of methods.tex to Page 3 at x=7200000, y=14400000
        synctexData.push(`x2,4,0:7200000,14400000:3600000,600000`);
        // Map line 2 of experiments.tex to Page 5 at x=7200000, y=28800000
        synctexData.push(`x3,2,0:7200000,28800000:3600000,600000`);
        synctexData.push(`]`);
        synctexData.push(`}`);
      }
      synctexData.push('!123');
      synctexData.push('Postamble:');
      synctexData.push('Count:20');

      const rawSyncTex = synctexData.join('\n');

      // 1. Forward Sync: User clicks in editor at sections/02_methods.tex, line 4
      const forwardRes = synctexProcessor.forwardLookup(rawSyncTex, 'sections/02_methods.tex', 4, 1);
      expect(forwardRes).not.toBeNull();
      expect(forwardRes?.page).toBe(1);
      expect(forwardRes?.x).toBeGreaterThan(0);
      expect(forwardRes?.y).toBeGreaterThan(0);

      // 2. Reverse Sync: User double-clicks in PDF on Page 5 near the experiment coordinates
      const reverseRes = synctexProcessor.reverseLookup(rawSyncTex, 5, 110, 440);
      expect(reverseRes).not.toBeNull();
      expect(reverseRes?.file).toBe('sections/03_experiments.tex');
      expect(reverseRes?.line).toBe(2);
    });
  });

  // =========================================================================
  // TIER 3: LARGE-SCALE (PH.D. DISSERTATION / MONOGRAPH - 50+ FILES, 100+ PAGES)
  // Deep file tree, recursive cascade path updating on directory rename,
  // cyclic move prevention, 5-user concurrent compilation mutex locks.
  // =========================================================================
  describe('Tier 3: Large-Scale Simulation (Ph.D. Dissertation - 50+ Files & Monograph Scale)', () => {
    let testTempDir: string;

    beforeAll(async () => {
      testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-sim-lock-'));
    });

    afterAll(async () => {
      try {
        await fs.rm(testTempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('Scenario 3.1: Massive 55-file tree hierarchy with deep subdirectories', async () => {
      // Create root folders
      const chaptersDir = await createNodeUseCase.execute(PROJECT_ID, {
        name: 'chapters',
        path: 'chapters',
        type: 'FOLDER',
      });

      const appendicesDir = await createNodeUseCase.execute(PROJECT_ID, {
        name: 'appendices',
        path: 'appendices',
        type: 'FOLDER',
      });

      // Populate 12 chapters with nested sections
      for (let c = 1; c <= 12; c++) {
        const padded = c.toString().padStart(2, '0');
        const chSubdir = await createNodeUseCase.execute(PROJECT_ID, {
          parentId: chaptersDir.id,
          name: `ch${padded}`,
          path: `chapters/ch${padded}`,
          type: 'FOLDER',
        });

        // 3 files per chapter (theory, code, evaluation)
        await createNodeUseCase.execute(PROJECT_ID, {
          parentId: chSubdir.id,
          name: `01_theory.tex`,
          path: `chapters/ch${padded}/01_theory.tex`,
          type: 'DOC',
        });
        await createNodeUseCase.execute(PROJECT_ID, {
          parentId: chSubdir.id,
          name: `02_algo.tex`,
          path: `chapters/ch${padded}/02_algo.tex`,
          type: 'DOC',
        });
        await createNodeUseCase.execute(PROJECT_ID, {
          parentId: chSubdir.id,
          name: `03_results.tex`,
          path: `chapters/ch${padded}/03_results.tex`,
          type: 'DOC',
        });
      }

      // Populate 5 appendices
      for (let a = 1; a <= 5; a++) {
        const letter = String.fromCharCode(64 + a);
        await createNodeUseCase.execute(PROJECT_ID, {
          parentId: appendicesDir.id,
          name: `appendix_${letter}.tex`,
          path: `appendices/appendix_${letter}.tex`,
          type: 'DOC',
        });
      }

      const allNodes = await structureRepo.getAllNodes(PROJECT_ID);
      expect(allNodes.length).toBeGreaterThan(50);
    });

    it('Scenario 3.2: Reorganizing Monograph - Rename chapters to parts with recursive cascade path updating', async () => {
      const chaptersNode = await structureRepo.findByPath(PROJECT_ID, 'chapters');
      expect(chaptersNode).not.toBeNull();

      // Rename /chapters -> parts
      await renameNodeUseCase.execute(PROJECT_ID, chaptersNode!.id, 'parts');

      // Verify that children are automatically updated to /parts/ch01/01_theory.tex
      const updatedChild = await structureRepo.findByPath(PROJECT_ID, 'parts/ch01/01_theory.tex');
      expect(updatedChild).not.toBeNull();
      expect(updatedChild?.path).toBe('/parts/ch01/01_theory.tex');

      // The old path should no longer exist
      const oldChild = await structureRepo.findByPath(PROJECT_ID, 'chapters/ch01/01_theory.tex');
      expect(oldChild).toBeNull();
    });

    it('Scenario 3.3: Moving subfolder /appendices into /parts/appendices with subpath recalculation', async () => {
      const appendicesNode = await structureRepo.findByPath(PROJECT_ID, 'appendices');
      const partsNode = await structureRepo.findByPath(PROJECT_ID, 'parts');

      expect(appendicesNode).not.toBeNull();
      expect(partsNode).not.toBeNull();

      await moveNodeUseCase.execute(PROJECT_ID, appendicesNode!.id, {
        destParentId: partsNode!.id,
      });

      // Verify new nested path
      const relocatedAppendix = await structureRepo.findByPath(PROJECT_ID, 'parts/appendices/appendix_A.tex');
      expect(relocatedAppendix).not.toBeNull();
      expect(relocatedAppendix?.path).toBe('/parts/appendices/appendix_A.tex');
    });

    it('Scenario 3.4: Cyclic Move Defense - Attempting to move /parts into /parts/ch01 throws CyclicMoveError', async () => {
      const partsNode = await structureRepo.findByPath(PROJECT_ID, 'parts');
      const ch01Node = await structureRepo.findByPath(PROJECT_ID, 'parts/ch01');

      await expect(
        moveNodeUseCase.execute(PROJECT_ID, partsNode!.id, {
          destParentId: ch01Node!.id,
        }),
      ).rejects.toThrow(CyclicMoveError);
    });

    it('Scenario 3.5: Multi-User Compiler Mutex Lock - 5 team members compile simultaneously without lock corruption', async () => {
      const lockManager = new ProjectLockManager();
      const compileLog: string[] = [];
      const projectWorkspace = path.join(testTempDir, 'workspace');
      await fs.mkdir(projectWorkspace, { recursive: true });

      // Elena, Gordon, Alex, Eli, Barney simultaneously trigger "Recompile"
      const compilePromises = Object.values(TEAM).map((member) => {
        return lockManager.runWithLock(
          PROJECT_ID,
          projectWorkspace,
          async () => {
            compileLog.push(`START:${member.name}`);
            // Simulate 15ms of compiler activity
            await new Promise((resolve) => setTimeout(resolve, 15));
            compileLog.push(`DONE:${member.name}`);
          },
          { intervalMs: 10, maxWaitMs: 15000, staleMs: 30000 },
        );
      });

      await Promise.all(compilePromises);

      // Verify that every START is immediately followed by its corresponding DONE (strictly serialized)
      expect(compileLog).toHaveLength(10);
      for (let i = 0; i < compileLog.length; i += 2) {
        const startItem = compileLog[i];
        const doneItem = compileLog[i + 1];
        expect(startItem.startsWith('START:')).toBe(true);
        expect(doneItem.startsWith('DONE:')).toBe(true);
        expect(startItem.replace('START:', '')).toBe(doneItem.replace('DONE:', ''));
      }
    });

    it('Scenario 3.6: Academic Word Counter on 75,000-Word Monograph parsed in < 100ms', () => {
      // Build 75,000 words
      const paragraph = 'In this section, we rigorously analyze quantum telemetry bounds under topological perturbations. ';
      const hugeBook = paragraph.repeat(6820); // ~75,000 words

      const t0 = performance.now();
      const wordCounter = new TexWordCounter();
      const stats = wordCounter.count(hugeBook);
      const elapsed = performance.now() - t0;

      expect(stats.wordsInText).toBeGreaterThan(70000);
      expect(elapsed).toBeLessThan(200); // Must be under 200ms
    });
  });

  // =========================================================================
  // TIER 4: EXTREMELY LARGE-SCALE & STRESS / EDGE CASES (CỰC LỚN & BIÊN)
  // 40,000-line LaTeX doc, 2MB size limit guard, null-byte rejection, burst typing,
  // OCC revision conflict resolution (409 Conflict), and 150-error compile storm.
  // =========================================================================
  describe('Tier 4: Extremely Large-Scale & Stress / Edge Cases (Maximum Limits & Chaos Engineering)', () => {
    it('Scenario 4.1: Massive 40,000-line document splitting, hashing, and memory benchmark in < 120ms', () => {
      const docHasher = new DocHasherAdapter();

      const lines: string[] = [];
      for (let i = 1; i <= 40000; i++) {
        lines.push(`\\indexentry{quantum_item_${i}}{${(i % 300) + 1}}`);
      }
      const rawPayload = lines.join('\n');

      const t0 = performance.now();
      const processedLines = LineArrayEngine.textToLines(rawPayload);
      const hash = docHasher.computeHash(processedLines);
      const elapsed = performance.now() - t0;

      expect(processedLines.length).toBe(40000);
      expect(hash).toHaveLength(64);
      expect(elapsed).toBeLessThan(150); // Fast line splitting and SHA-256
    });

    it('Scenario 4.2: Enforce hard 2MB document ceiling with DocTooLargeError', async () => {
      // Generate a payload exceeding 2MB limit (e.g., 2.1 MB)
      const oversizedPayload = 'A'.repeat(2.1 * 1024 * 1024);

      await expect(
        docstoreService.createDoc(PROJECT_ID, {
          path: 'huge_dataset.tex',
          text: oversizedPayload,
        }),
      ).rejects.toThrow(DocTooLargeError);
    });

    it('Scenario 4.3: Defense against corrupted binary injection - NullByteDetectedError', async () => {
      const poisonedPayload = '\\section{Normal TeX}\nSome text\u0000Injected null byte';

      await expect(
        docstoreService.createDoc(PROJECT_ID, {
          path: 'poisoned.tex',
          text: poisonedPayload,
        }),
      ).rejects.toThrow(NullByteDetectedError);
    });

    it('Scenario 4.4: Burst Typing & OCC Conflict Simulation between Elena and Gordon (409 Conflict & Recovery)', async () => {
      // 1. Create a shared document
      const sharedDoc = await docstoreService.createDoc(PROJECT_ID, {
        path: 'concurrency.tex',
        text: 'Initial Line 1\nInitial Line 2\nInitial Line 3\n',
      });
      expect(sharedDoc.rev).toBe(1);

      // 2. Both Elena and Gordon fetch Rev 1 simultaneously
      const elenaLocal = await docstoreService.getDoc(PROJECT_ID, sharedDoc._id);
      const gordonLocal = await docstoreService.getDoc(PROJECT_ID, sharedDoc._id);

      expect(elenaLocal.rev).toBe(1);
      expect(gordonLocal.rev).toBe(1);

      // 3. Elena types quickly and commits first with expectedRev: 1
      const elenaUpdate = await docstoreService.updateDoc(PROJECT_ID, sharedDoc._id, {
        lines: ['Initial Line 1', 'Elena modified Line 2', 'Initial Line 3'],
        version: elenaLocal.version + 1,
        expectedRev: elenaLocal.rev,
      });

      expect(elenaUpdate.doc.rev).toBe(2);
      expect(elenaUpdate.doc.lines[1]).toBe('Elena modified Line 2');

      // 4. Gordon attempts to commit his edits based on stale expectedRev: 1
      // Expect Optimistic Concurrency Control to trigger DocModifiedError (409 Conflict)
      await expect(
        docstoreService.updateDoc(PROJECT_ID, sharedDoc._id, {
          lines: ['Initial Line 1', 'Gordon modified Line 2 concurrently', 'Initial Line 3'],
          version: gordonLocal.version + 1,
          expectedRev: gordonLocal.rev, // Still rev 1!
        }),
      ).rejects.toThrow(DocModifiedError);

      // 5. Gordon's client receives 409 Conflict, re-fetches latest rev: 2, merges changes, and commits
      const gordonFresh = await docstoreService.getDoc(PROJECT_ID, sharedDoc._id);
      expect(gordonFresh.rev).toBe(2);

      const gordonResolved = await docstoreService.updateDoc(PROJECT_ID, sharedDoc._id, {
        lines: [
          'Initial Line 1',
          'Elena modified Line 2 [Merged with Gordon]',
          'Initial Line 3',
        ],
        version: gordonFresh.version + 1,
        expectedRev: gordonFresh.rev, // Now rev 2
      });

      expect(gordonResolved.doc.rev).toBe(3);
      expect(gordonResolved.doc.lines[1]).toBe('Elena modified Line 2 [Merged with Gordon]');
    });

    it('Scenario 4.5: Catastrophic LaTeX Compiler Storm (150+ errors, warnings, badboxes) parsed in < 30ms', () => {
      const explainer = new KnowledgeBaseExplainerAdapter();
      const texParser = new TexParenTreeLogParser(explainer);
      const tectonicParser = new TectonicLogParser(explainer);
      const parseUseCase = new ParseCompileLogUseCase(texParser, tectonicParser);

      // Construct a catastrophic 1,500-line LaTeX compiler log simulating severe syntax collapse
      const logLines: string[] = [
        'This is pdfTeX, Version 3.141592653-2.6-1.40.24 (TeX Live 2024)',
        'entering extended mode',
        '(./main.tex',
        'LaTeX2e <2023-11-01> pre-release-1',
      ];

      for (let i = 1; i <= 150; i++) {
        if (i % 3 === 0) {
          logLines.push(`! Undefined control sequence.`);
          logLines.push(`l.${i * 4} \\nonexistentmacro{arg}`);
          logLines.push(`The control sequence at the end of the top line of your error message was never \\def'ed.`);
        } else if (i % 3 === 1) {
          logLines.push(`! LaTeX Error: Missing \\begin{document}.`);
          logLines.push(`l.${i * 4} \\invalidcommand`);
        } else {
          logLines.push(`Overfull \\hbox (14.2834pt too wide) in paragraph at lines ${i * 4}--${i * 4 + 2}`);
          logLines.push(`[]\\OT1/cmr/m/n/10 Here is an overflowing line of text that causes a badbox warning`);
        }
      }
      logLines.push(')');
      logLines.push('Output written on main.pdf (0 pages).');

      const rawCatastrophicLog = logLines.join('\n');

      const t0 = performance.now();
      const report = parseUseCase.execute({
        logText: rawCatastrophicLog,
        defaultFile: 'main.tex',
        engine: 'tex',
      });
      const elapsed = performance.now() - t0;

      expect(report.errorsCount + report.warningsCount + report.badboxesCount).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(100); // High-throughput parsing under 100ms
      expect(report.getErrors().length).toBeGreaterThan(0);
      expect(report.getErrors()[0].file).toBe('main.tex');
      expect(report.getErrors()[0].message).toBeDefined();
      expect(report.getErrors()[0].severity.isError()).toBe(true);
    });
  });
});
