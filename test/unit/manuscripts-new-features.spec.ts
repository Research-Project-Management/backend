/**
 * test/unit/manuscripts-new-features.spec.ts
 * Comprehensive unit tests verifying the 4 new backend capabilities:
 * 1. Binary Yjs CRDT Real-time Sync
 * 2. Linked Files Engine (URL & Citation Library Sync)
 * 3. Static Linter & Pre-compile Auto-Fixer
 * 4. Compile Fair-Queue & Concurrency Limiter
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { YjsDocManagerAdapter } from '@/modules/realtime/manuscripts/core/adapters/crdt/yjs-doc-manager.adapter';
import { FastSyntaxLinterAdapter } from '@/modules/manuscripts/diagnostics/core/adapters/linter/fast-syntax-linter.adapter';
import { CompileFairQueue } from '@/modules/manuscripts/clsi/core/pipeline/compile-fair-queue';
import { LinkedFileEntity } from '@/modules/manuscripts/linked-files/core/domain/entities/linked-file.entity';
import { RedisLinkedFilesRepository } from '@/modules/manuscripts/linked-files/core/adapters/persistence/redis-linked-files.repository';
import { CreateLinkedFileUseCase } from '@/modules/manuscripts/linked-files/core/use-cases/create-linked-file.use-case';
import { RefreshLinkedFileUseCase } from '@/modules/manuscripts/linked-files/core/use-cases/refresh-linked-file.use-case';
import { DeleteLinkedFileUseCase } from '@/modules/manuscripts/linked-files/core/use-cases/delete-linked-file.use-case';
import { LinkedFilesService } from '@/modules/manuscripts/linked-files/linked-files.service';
import { ListLinkedFilesUseCase } from '@/modules/manuscripts/linked-files/core/use-cases/list-linked-files.use-case';
import {
  assertSafeExternalUrl,
  isPrivateOrReservedIPv4,
} from '@/modules/manuscripts/linked-files/core/utils/ssrf-guard.util';

describe('Manuscripts 4 Major Backend Capabilities (Overleaf Parity)', () => {
  // =========================================================================
  // 1. Binary Yjs CRDT Real-time Sync Tests
  // =========================================================================
  describe('1. Binary Yjs CRDT Synchronization Engine', () => {
    let yjsDocManager: YjsDocManagerAdapter;
    let mockDocstoreService: any;
    let mockRedisService: any;

    beforeEach(() => {
      mockDocstoreService = {
        getRawDoc: jest
          .fn()
          .mockResolvedValue(
            '\\documentclass{article}\n\\begin{document}\nInitial text\n\\end{document}',
          ),
        getDoc: jest.fn().mockResolvedValue({ version: 1, rev: 1 }),
        updateDoc: jest.fn().mockResolvedValue({ success: true, rev: 2 }),
      };

      mockRedisService = {
        isReady: jest.fn().mockReturnValue(false),
        getClient: jest.fn().mockReturnValue(null),
      };

      yjsDocManager = new YjsDocManagerAdapter(
        mockRedisService,
        mockDocstoreService,
      );
    });

    it('should initialize and hydrate Y.Doc from Docstore baseline', async () => {
      const session = await yjsDocManager.getOrCreateDoc('proj-1', 'doc-1');
      expect(session).toBeDefined();
      expect(session.yText.toString()).toContain('Initial text');
    });

    it('should perform binary sync-step-1 and sync-step-2 exchange between client and server', async () => {
      const clientDoc = new Y.Doc();

      // Step 1: Client writes state vector
      const clientEncoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(clientEncoder, clientDoc);
      const step1Payload = encoding.toUint8Array(clientEncoder);

      // Server handles sync message
      const serverRes = await yjsDocManager.handleSyncMessage(
        'proj-1',
        'doc-1',
        step1Payload,
        'client-socket-1',
      );
      expect(serverRes.reply).toBeDefined();

      // Client applies server response
      const clientDecoder = decoding.createDecoder(
        new Uint8Array(serverRes.reply!),
      );
      const clientRespEncoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(
        clientDecoder,
        clientRespEncoder,
        clientDoc,
        'server',
      );

      expect(clientDoc.getText('latex').toString()).toContain('Initial text');
    });

    it('should handle incremental sync-update from collaborator without conflicts', async () => {
      const clientDoc = new Y.Doc();
      const serverSession = await yjsDocManager.getOrCreateDoc(
        'proj-1',
        'doc-1',
      );

      // Sync baseline to client first
      const stateVector = Y.encodeStateVector(clientDoc);
      const step2Reply = await yjsDocManager.handleSyncStep1(
        'proj-1',
        'doc-1',
        stateVector,
      );
      const decoder = decoding.createDecoder(new Uint8Array(step2Reply));
      syncProtocol.readSyncMessage(
        decoder,
        encoding.createEncoder(),
        clientDoc,
        'server',
      );

      // Client edits text
      clientDoc.getText('latex').insert(0, '% CRDT Edit\n');
      const update = Y.encodeStateAsUpdate(clientDoc);

      // Server applies update
      const broadcastBuffer = await yjsDocManager.handleSyncUpdate(
        'proj-1',
        'doc-1',
        update,
        'client-socket-1',
      );
      expect(broadcastBuffer).toBeDefined();

      const serverText = await yjsDocManager.getText('proj-1', 'doc-1');
      expect(serverText.startsWith('% CRDT Edit\n')).toBe(true);
    });

    it('should flush Y.Doc back to Docstore on flushDoc', async () => {
      await yjsDocManager.getOrCreateDoc('proj-1', 'doc-1');
      await yjsDocManager.flushDoc('proj-1', 'doc-1');

      expect(mockDocstoreService.updateDoc).toHaveBeenCalledWith(
        'proj-1',
        'doc-1',
        expect.objectContaining({
          lines: expect.any(Array),
          version: 2,
        }),
      );
    });
  });

  // =========================================================================
  // 2. Linked Files Engine Tests
  // =========================================================================
  describe('2. Linked Files Engine (URL & Citation Library)', () => {
    let repo: RedisLinkedFilesRepository;
    let service: LinkedFilesService;
    let mockStructureService: any;
    let mockDocstoreService: any;
    let mockFilestoreService: any;
    let mockCitationsService: any;
    let mockRealtimeService: any;

    beforeEach(() => {
      repo = new RedisLinkedFilesRepository();

      mockStructureService = {
        createNode: jest
          .fn()
          .mockResolvedValue({ id: 'node-123', path: '/dataset.csv' }),
        getNodeByPath: jest
          .fn()
          .mockResolvedValue({ id: 'node-bib', docId: 'doc-bib' }),
        deleteNode: jest.fn().mockResolvedValue([]),
      };

      mockDocstoreService = {
        createDoc: jest
          .fn()
          .mockResolvedValue({ _id: 'doc-123', path: 'dataset.csv' }),
        getDoc: jest.fn().mockResolvedValue({ version: 1 }),
        updateDoc: jest.fn().mockResolvedValue({ success: true, rev: 2 }),
      };

      mockFilestoreService = {
        uploadFileFromBuffer: jest
          .fn()
          .mockResolvedValue({ id: 'file-123', name: 'figure.png' }),
      };

      mockCitationsService = {
        syncLibraryCollection: jest
          .fn()
          .mockResolvedValue({ syncedCount: 5, filePath: 'references.bib' }),
      };

      mockRealtimeService = {
        broadcastFileTreeChange: jest.fn(),
        broadcastEvent: jest.fn(),
      };

      const createUseCase = new CreateLinkedFileUseCase(
        repo,
        mockStructureService,
        mockDocstoreService,
        mockFilestoreService,
        mockCitationsService,
        mockRealtimeService,
      );

      const refreshUseCase = new RefreshLinkedFileUseCase(
        repo,
        mockStructureService,
        mockDocstoreService,
        mockFilestoreService,
        mockCitationsService,
        mockRealtimeService,
      );

      const listUseCase = new ListLinkedFilesUseCase(repo);
      const deleteUseCase = new DeleteLinkedFileUseCase(
        repo,
        mockStructureService,
      );

      service = new LinkedFilesService(
        createUseCase,
        refreshUseCase,
        listUseCase,
        deleteUseCase,
        repo,
      );
    });

    it('should create and link a Zotero reference library to references.bib', async () => {
      const result = await service.create(
        'proj-1',
        {
          name: 'references.bib',
          provider: 'zotero',
          collectionId: 'col-456',
          autoRefresh: true,
        },
        'user-1',
      );

      expect(result).toBeDefined();
      expect(result.name).toBe('references.bib');
      expect(result.provider).toBe('zotero');
      expect(result.status).toBe('synced');
      expect(mockCitationsService.syncLibraryCollection).toHaveBeenCalled();
      expect(mockRealtimeService.broadcastFileTreeChange).toHaveBeenCalled();
    });

    it('should list all linked files for a project', async () => {
      await service.create('proj-1', {
        name: 'references.bib',
        provider: 'zotero',
        collectionId: 'col-456',
      });

      const list = await service.list('proj-1');
      expect(list.length).toBe(1);
      expect(list[0]?.name).toBe('references.bib');
    });

    it('should refresh a linked file on demand', async () => {
      const created = await service.create('proj-1', {
        name: 'references.bib',
        provider: 'zotero',
        collectionId: 'col-456',
      });

      const refreshed = await service.refresh('proj-1', created.id);
      expect(refreshed.status).toBe('synced');
      expect(mockCitationsService.syncLibraryCollection).toHaveBeenCalledTimes(
        2,
      );
    });

    it('should delete and unlink a file from repository', async () => {
      const created = await service.create('proj-1', {
        name: 'references.bib',
        provider: 'zotero',
        collectionId: 'col-456',
      });

      await service.delete('proj-1', created.id, true);
      const list = await service.list('proj-1');
      expect(list.length).toBe(0);
      expect(mockStructureService.deleteNode).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Static Linter & Pre-compile Auto-Fixer Tests
  // =========================================================================
  describe('3. Static Linter & Pre-compile Auto-Fixer', () => {
    let linter: FastSyntaxLinterAdapter;

    beforeEach(() => {
      linter = new FastSyntaxLinterAdapter();
    });

    it('should detect unclosed environment and suggest quickFix', () => {
      const source = `\\documentclass{article}
\\begin{document}
\\begin{equation}
E = mc^2
\\end{document}`;

      const items = linter.lint(source, 'main.tex');
      const unclosed = items.find((i) => i.code === 'UNCLOSED_ENVIRONMENT');
      expect(unclosed).toBeDefined();
      expect(unclosed?.message).toContain('equation');
      expect(unclosed?.quickFix).toBeDefined();
    });

    it('should detect naked underscores outside math mode', () => {
      const source = `This is a test_variable without math mode.`;
      const items = linter.lint(source, 'main.tex');
      const naked = items.find((i) => i.code === 'MISSING_MATH_DELIMITER');
      expect(naked).toBeDefined();
      expect(naked?.quickFix?.replacementText).toBe('\\_');
    });

    it('should detect missing citation keys compared against known bib keys', () => {
      const source = `As proven by \\cite{einstein1905} and \\cite{unknownKey2024}.`;
      const knownKeys = new Set(['einstein1905', 'newton1687']);

      const items = linter.lint(source, 'main.tex', knownKeys);
      const missingCite = items.find((i) => i.code === 'MISSING_CITATION_KEY');
      expect(missingCite).toBeDefined();
      expect(missingCite?.message).toContain('unknownKey2024');
    });

    it('should not flag special characters inside verbatim environments', () => {
      const source = `\\begin{verbatim}
test_variable & unescaped % inside verbatim
\\end{verbatim}`;

      const items = linter.lint(source, 'main.tex');
      expect(items.length).toBe(0);
    });

    it('should auto-fix smart quotes, naked underscores, and unclosed environments', () => {
      const badSource = `“Hello World” with my_var and 99% accuracy.
\\begin{center}
Centered text`;

      const fixResult = linter.autoFix(badSource);
      expect(fixResult.isFixed).toBe(true);
      expect(fixResult.fixedSource).toContain("``Hello World''");
      expect(fixResult.fixedSource).toContain('my\\_var');
      expect(fixResult.fixedSource).toContain('99\\%');
      expect(fixResult.fixedSource).toContain('\\end{center}');
      expect(fixResult.appliedFixes.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // 4. Compile Fair-Queue & Concurrency Limiter Tests
  // =========================================================================
  describe('4. Compile Fair-Queue & Concurrency Limiter', () => {
    let queue: CompileFairQueue;
    let mockRealtime: any;

    beforeEach(() => {
      queue = new CompileFairQueue({
        maxCompilesPerMinute: 5,
        minIntervalBetweenCompilesMs: 50,
      });

      mockRealtime = {
        broadcastCompileProgress: jest.fn(),
      };
    });

    it('should execute a compile task successfully', async () => {
      const result = await queue.schedule(
        'proj-1',
        'user-1',
        mockRealtime,
        async (signal, onChunk) => {
          onChunk('Compiling page 1...\n');
          return { success: true, pdf: 'base64-pdf' };
        },
      );

      expect(result.success).toBe(true);
      expect(mockRealtime.broadcastCompileProgress).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          status: 'compiling',
          logs: ['Compiling page 1...\n'],
        }),
      );
    });

    it('should abort in-flight compilation when a newer request arrives for the same project', async () => {
      let firstCompileAborted = false;

      // Start first long compile
      const p1 = queue.schedule(
        'proj-1',
        'user-1',
        mockRealtime,
        async (signal) => {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              firstCompileAborted = true;
              resolve({ success: false, error: 'Aborted' });
            });
            setTimeout(() => resolve({ success: true, pdf: 'slow-pdf' }), 1000);
          });
        },
      );

      // Almost immediately, start second compile for the same project
      const p2 = queue.schedule('proj-1', 'user-1', mockRealtime, async () => {
        return { success: true, pdf: 'fresh-pdf' };
      });

      const [res1, res2]: any[] = await Promise.all([p1, p2]);
      expect(firstCompileAborted).toBe(true);
      expect(res1.success).toBe(false);
      expect(res2.success).toBe(true);
      expect(res2.pdf).toBe('fresh-pdf');
    });

    it('should throttle compilation requests exceeding rate limit', async () => {
      // Execute 5 compiles (allowed limit)
      for (let i = 0; i < 5; i++) {
        await queue.schedule(
          'proj-rate-test',
          'user-1',
          mockRealtime,
          async () => ({ ok: true }),
        );
      }

      // 6th compile within same minute should throw 429 TOO_MANY_REQUESTS
      await expect(
        queue.schedule('proj-rate-test', 'user-1', mockRealtime, async () => ({
          ok: true,
        })),
      ).rejects.toThrow();
    });

    it('should allow manual cancellation of in-flight compile', async () => {
      let aborted = false;

      const compilePromise = queue.schedule(
        'proj-cancel',
        'user-1',
        mockRealtime,
        async (signal) => {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ cancelled: true });
            });
            setTimeout(() => resolve({ cancelled: false }), 1000);
          });
        },
      );

      expect(queue.isInFlight('proj-cancel')).toBe(true);
      const didCancel = queue.cancel('proj-cancel');
      expect(didCancel).toBe(true);

      const result: any = await compilePromise;
      expect(aborted).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(queue.isInFlight('proj-cancel')).toBe(false);
    });
  });

  // =========================================================================
  // 5. Security Hardening & Concurrency Lifecycle Safeguards
  // =========================================================================
  describe('5. Security Hardening & Concurrency Lifecycle Safeguards', () => {
    describe('SSRF Protection (Linked Files Guard)', () => {
      it('should accurately identify private, loopback, and metadata IPv4 subnets', () => {
        expect(isPrivateOrReservedIPv4('127.0.0.1')).toBe(true);
        expect(isPrivateOrReservedIPv4('169.254.169.254')).toBe(true);
        expect(isPrivateOrReservedIPv4('10.0.0.5')).toBe(true);
        expect(isPrivateOrReservedIPv4('192.168.1.100')).toBe(true);
        expect(isPrivateOrReservedIPv4('172.16.5.20')).toBe(true);
        expect(isPrivateOrReservedIPv4('8.8.8.8')).toBe(false);
        expect(isPrivateOrReservedIPv4('1.1.1.1')).toBe(false);
      });

      it('should reject cloud metadata service URL (169.254.169.254)', async () => {
        await expect(
          assertSafeExternalUrl(
            'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          ),
        ).rejects.toThrow('SSRF Protection');
      });

      it('should reject localhost and internal loopback addresses', async () => {
        await expect(
          assertSafeExternalUrl('http://localhost:5432/api'),
        ).rejects.toThrow('SSRF Protection');
        await expect(
          assertSafeExternalUrl('http://127.0.0.1:6379'),
        ).rejects.toThrow('SSRF Protection');
      });

      it('should reject non-HTTP protocols (file, ftp)', async () => {
        await expect(
          assertSafeExternalUrl('file:///etc/passwd'),
        ).rejects.toThrow('SSRF Protection');
        await expect(
          assertSafeExternalUrl('ftp://ftp.server.com/archive.zip'),
        ).rejects.toThrow('SSRF Protection');
      });
    });

    describe('Y.Doc In-Memory Garbage Collection & Lifecycle', () => {
      it('should sweep and evict idle sessions older than threshold', async () => {
        const mockDocstore = {
          getRawDoc: jest.fn().mockResolvedValue('text'),
          getDoc: jest.fn().mockResolvedValue({ version: 1 }),
          updateDoc: jest.fn().mockResolvedValue({ success: true }),
        };
        const adapter = new YjsDocManagerAdapter(
          undefined,
          mockDocstore as any,
        );

        // Create an active session
        const session = await adapter.getOrCreateDoc('proj-sweep', 'doc-sweep');
        expect(session).toBeDefined();

        // Simulate session being idle for 20 minutes (threshold is 15 minutes)
        session.lastActiveAt = Date.now() - 20 * 60 * 1000;

        const evicted = await adapter.sweepIdleDocs();
        expect(evicted).toBe(1);

        // Clean up adapter timers
        await adapter.onModuleDestroy();
      });

      it('should cleanly flush and destroy all active sessions on module shutdown', async () => {
        const mockDocstore = {
          getRawDoc: jest.fn().mockResolvedValue('doc-content'),
          getDoc: jest.fn().mockResolvedValue({ version: 1 }),
          updateDoc: jest.fn().mockResolvedValue({ success: true }),
        };
        const adapter = new YjsDocManagerAdapter(
          undefined,
          mockDocstore as any,
        );

        await adapter.getOrCreateDoc('proj-shutdown-1', 'doc-1');
        await adapter.getOrCreateDoc('proj-shutdown-2', 'doc-2');

        await adapter.onModuleDestroy();
        expect(mockDocstore.updateDoc).toHaveBeenCalled();
      });
    });
  });
});
