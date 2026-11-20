import { ConflictException, ForbiddenException } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { DocModifiedError } from '@/modules/pages/docstore/domain/doc.errors';
import {
  toSuggestionDto,
  validateSuggestionRange,
} from '@/modules/pages/review/services/scope.helper';
import { YjsUpdateValidator } from '@/modules/realtime/channels/pages/yjs/sync';
import { YjsService } from '@/modules/realtime/channels/pages/yjs/engine';
import { RealtimeValidationFailedException } from '@/modules/realtime/core/errors';
import {
  PAGES_REALTIME_DEFAULTS,
  PagesRealtimeConfigService,
} from '@/modules/realtime/channels/pages/config';
import {
  Snapshot,
  VersionLabel,
  VersionNotFoundException,
  DuplicateLabelException,
  EmptyProjectException,
  InvalidVersionLabelException,
  FileSnapshotVo,
  DiffEngine,
} from '@/modules/pages/project-history/domain';
import {
  PageHistoryMapper,
  ProjectHistoryRepository,
} from '@/modules/pages/project-history/project-history.repository';
import { ProjectHistoryService } from '@/modules/pages/project-history/project-history.service';
import type {
  PageSnapshotCollectorAdapter,
  PageSnapshotRestorerAdapter,
} from '@/modules/pages/project-history/adapters/project-history.adapters';
import {
  ChangeNotFoundError,
  LinePatcher,
  ResolvedThreadError,
  StaleAnchorError,
  TextRange,
  ThreadNotFoundError,
  TrackChange,
} from '@/modules/pages/review/domain';
import type { DocPatcher } from '@/modules/pages/review/doc-patcher.adapter';
import type { ReviewRepository } from '@/modules/pages/review/review.repository';
import { CommentsService } from '@/modules/pages/review/services/comments.service';
import { SuggestionsService } from '@/modules/pages/review/services/suggestions.service';
import { Role } from '@/modules/project/access';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_A_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_B_ID = '33333333-3333-4333-8333-333333333333';
const DOC_ID = '44444444-4444-4444-8444-444444444444';
const AUTHOR_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';

describe('Khối 2 / Tầng 3 — Live Yjs Sync, Project History & Track Changes / Review', () => {
  describe('1. Domain Exception HTTP Status Codes & Coordinate Symmetry', () => {
    it('exposes accurate HTTP statusCode values across Docstore, History, and TrackChanges domain errors', () => {
      expect(new DocModifiedError().statusCode).toBe(409);
      expect(new VersionNotFoundException(SPACE_ID, 7).statusCode).toBe(404);
      expect(new DuplicateLabelException(SPACE_ID, 'v1.0').statusCode).toBe(
        409,
      );
      expect(new EmptyProjectException(SPACE_ID).statusCode).toBe(400);
      expect(new InvalidVersionLabelException().statusCode).toBe(400);
      expect(new ChangeNotFoundError('chg-1').statusCode).toBe(404);
      expect(new ThreadNotFoundError('thr-1').statusCode).toBe(404);
      expect(new ResolvedThreadError('thr-1').statusCode).toBe(409);
      expect(new StaleAnchorError('chg-1').statusCode).toBe(409);
    });

    it('converts 1-based UI suggestion coordinates to 0-based DB coordinates and back symmetrically', () => {
      const dbRange = validateSuggestionRange({
        fromLine: 2,
        toLine: 4,
        fromColumn: 3,
        toColumn: 9,
      });
      expect(dbRange).toEqual({
        startLine: 1,
        endLine: 3,
        startCol: 3,
        endCol: 9,
      });

      const now = new Date('2026-10-01T00:00:00Z');
      const dto = toSuggestionDto(
        {
          id: 'sug-1',
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
          docId: DOC_ID,
          createdById: AUTHOR_ID,
          type: 'insert',
          status: 'pending',
          text: 'added clause',
          startLine: dbRange.startLine,
          startCol: dbRange.startCol,
          endLine: dbRange.endLine,
          endCol: dbRange.endCol,
          resolvedById: null,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        } as never,
        new Map([[AUTHOR_ID, { id: AUTHOR_ID, name: 'Dr. Alice' }]]),
      );

      expect(dto.fromLine).toBe(2);
      expect(dto.toLine).toBe(4);
      expect(dto.fromColumn).toBe(3);
      expect(dto.toColumn).toBe(9);
      expect(dto.suggestedText).toBe('added clause');
    });
  });

  describe('2. Yjs Update Validation & Non-Mutating Size Enforcement', () => {
    let yjsService: YjsService | null = null;

    afterEach(async () => {
      if (yjsService) {
        await yjsService.onModuleDestroy();
        yjsService = null;
      }
    });

    it('YjsUpdateValidator rejects non-binary payloads and oversized pre/post states', () => {
      const validator = new YjsUpdateValidator();
      expect(() => validator.validateSyncPayload('base64-not-binary')).toThrow(
        RealtimeValidationFailedException,
      );

      const largeDoc = new Y.Doc();
      largeDoc.getText('latex').insert(0, 'x'.repeat(250));
      expect(() => validator.validatePostApplySize(largeDoc, 128, 0)).toThrow(
        RealtimeValidationFailedException,
      );
      largeDoc.destroy();
    });

    it('YjsService validates post-apply size on a temporary doc BEFORE mutating active session', async () => {
      const docstoreMock = {
        getDoc: jest.fn().mockResolvedValue({
          id: DOC_ID,
          projectId: SPACE_ID,
          lines: ['\\section{Start}'],
          rev: 1,
          version: 1,
        }),
      };
      const configMock: Partial<PagesRealtimeConfigService> = {
        getYjsConfig: () => ({
          ...PAGES_REALTIME_DEFAULTS.yjs,
          maxDocumentSizeBytes: 256,
          maxUpdateSizeBytes: 512 * 1024,
        }),
      };
      yjsService = new YjsService(
        undefined,
        docstoreMock as never,
        new YjsUpdateValidator(),
        configMock as PagesRealtimeConfigService,
      );

      const remoteDoc = new Y.Doc();
      remoteDoc.getText('latex').insert(0, 'A'.repeat(220));
      const update = Y.encodeStateAsUpdate(remoteDoc);
      remoteDoc.destroy();

      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      const frame = Buffer.from(encoding.toUint8Array(enc));

      await expect(
        yjsService.handleSyncMessage(SPACE_ID, DOC_ID, frame, 'sock-1'),
      ).rejects.toThrow(RealtimeValidationFailedException);

      const session = await yjsService.getOrCreateDoc(SPACE_ID, DOC_ID);
      expect(session.yText.toString()).toBe('\\section{Start}');
    });
  });

  describe('3. Project History Multi-Page Isolation & Non-Destructive Restore', () => {
    it('preserves canonical spaceId and pageId across PageHistoryMapper and Snapshot/VersionLabel entities', () => {
      const now = new Date('2026-10-01T12:00:00Z');
      const snap = PageHistoryMapper.toDomainHeader({
        id: 'snap-1',
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        version: 3,
        summary: 'Milestone A',
        createdById: AUTHOR_ID,
        isAutomatic: false,
        createdAt: now,
        files: { '/main.tex': { type: 'doc', docId: DOC_ID, lines: ['hi'] } },
      });
      const label = VersionLabel.create({
        projectId: SPACE_ID,
        pageId: PAGE_B_ID,
        snapshotId: 'snap-2',
        version: 4,
        label: 'Camera Ready',
        createdById: AUTHOR_ID,
      });

      expect(snap.spaceId).toBe(SPACE_ID);
      expect(snap.pageId).toBe(PAGE_A_ID);
      expect(snap.fileCount).toBe(1);
      expect(label.spaceId).toBe(SPACE_ID);
      expect(label.pageId).toBe(PAGE_B_ID);
    });

    it('ProjectHistoryService.restoreSingleFile forwards pageId and records non-destructive snapshot', async () => {
      const targetSnapshot = Snapshot.create({
        id: 'snap-v2',
        projectId: SPACE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        version: 2,
        summary: 'v2',
        createdById: AUTHOR_ID,
        files: new Map([
          [
            '/chapter1.tex',
            FileSnapshotVo.createDoc(
              '/chapter1.tex',
              DOC_ID,
              ['Restored line'],
              'hash-v2',
              false,
            ),
          ],
        ]),
      });

      const mockRepo = {
        findByVersion: jest.fn().mockResolvedValue(targetSnapshot),
        getLatestVersion: jest.fn().mockResolvedValue(4),
        saveSnapshot: jest.fn().mockImplementation(async (s: Snapshot) => s),
      } as unknown as ProjectHistoryRepository;

      const mockCollector = {
        collectCurrentState: jest
          .fn()
          .mockResolvedValue(
            new Map([
              [
                '/chapter1.tex',
                FileSnapshotVo.createDoc(
                  '/chapter1.tex',
                  DOC_ID,
                  ['Restored line'],
                  'hash-new',
                  false,
                ),
              ],
            ]),
          ),
      } as unknown as PageSnapshotCollectorAdapter;

      const mockRestorer = {
        restoreSingleFileToState: jest.fn().mockResolvedValue({
          path: '/chapter1.tex',
          docId: DOC_ID,
          fileId: null,
          content: 'Restored line',
          rev: 12,
        }),
      } as unknown as PageSnapshotRestorerAdapter;

      const service = new ProjectHistoryService(
        mockRepo,
        mockCollector,
        mockRestorer,
        undefined,
        undefined,
        new DiffEngine(),
      );

      const res = await service.restoreSingleFile(
        SPACE_ID,
        2,
        { pathname: '/chapter1.tex', pageId: PAGE_A_ID },
        AUTHOR_ID,
        PAGE_A_ID,
      );

      expect(mockRepo.findByVersion).toHaveBeenCalledWith(
        SPACE_ID,
        2,
        PAGE_A_ID,
      );
      expect(mockRestorer.restoreSingleFileToState).toHaveBeenCalledWith(
        SPACE_ID,
        targetSnapshot,
        '/chapter1.tex',
        undefined,
        PAGE_A_ID,
      );
      expect(mockCollector.collectCurrentState).toHaveBeenCalledWith(
        SPACE_ID,
        PAGE_A_ID,
      );
      expect(res).toMatchObject({
        path: '/chapter1.tex',
        version: 2,
        newVersion: 5,
        docId: DOC_ID,
        rev: 12,
      });
    });
  });

  describe('4. Track Changes LinePatcher Anchor Safety & CAS Concurrency', () => {
    it('throws StaleAnchorError (409) when delete text is missing or ambiguous in nearby context', () => {
      const missingChange = TrackChange.create({
        id: 'chg-missing',
        spaceId: SPACE_ID,
        docId: DOC_ID,
        type: 'delete',
        text: 'obsolete phrase',
        range: TextRange.create({
          startLine: 0,
          startCol: 0,
          endLine: 0,
          endCol: 15,
        }),
      });

      expect(() =>
        LinePatcher.computeAcceptedPatch(
          ['completely different sentence'],
          missingChange,
        ),
      ).toThrow(StaleAnchorError);

      const ambiguousChange = TrackChange.create({
        id: 'chg-ambiguous',
        spaceId: SPACE_ID,
        docId: DOC_ID,
        type: 'delete',
        text: 'dup',
        range: TextRange.create({
          startLine: 0,
          startCol: 0,
          endLine: 0,
          endCol: 3,
        }),
      });

      expect(() =>
        LinePatcher.computeAcceptedPatch(
          ['wrong header', 'prefix dup and dup again'],
          ambiguousChange,
        ),
      ).toThrow(StaleAnchorError);
    });

    it('atomically claims pending change via CAS and reverts claim if DocPatcher fails', async () => {
      const now = new Date();
      const CHG_CAS_ID = '66666666-6666-4666-8666-666666666661';
      const pendingRow = {
        id: CHG_CAS_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        docId: DOC_ID,
        type: 'delete' as const,
        status: 'pending' as const,
        text: 'old',
        startLine: 0,
        startCol: 0,
        endLine: 0,
        endCol: 3,
        createdById: AUTHOR_ID,
        resolvedById: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      const revertClaimedChanges = jest.fn().mockResolvedValue(undefined);
      const repoMock = {
        getPrisma: jest.fn().mockReturnValue({}),
        findChange: jest.fn().mockResolvedValue(pendingRow),
        claimPendingChanges: jest.fn().mockResolvedValue([CHG_CAS_ID]),
        revertClaimedChanges,
      } as unknown as ReviewRepository;

      const patcherMock = {
        applyChange: jest
          .fn()
          .mockRejectedValue(new StaleAnchorError(CHG_CAS_ID)),
      } as unknown as DocPatcher;

      const scopeRepoMock = {
        findDocInProject: jest.fn().mockResolvedValue({
          id: DOC_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
        }),
        getPrisma: jest.fn().mockReturnValue({}),
      };
      const userResolverMock = {
        resolveUserNames: jest.fn().mockResolvedValue(new Map()),
      };
      const pageServiceMock = {
        resolveActiveProjectId: jest.fn().mockReturnValue(SPACE_ID),
        resolveProjectId: jest.fn().mockResolvedValue(SPACE_ID),
      };

      const service = new SuggestionsService(
        repoMock,
        patcherMock,
        scopeRepoMock as never,
        userResolverMock,
        pageServiceMock as never,
      );

      await expect(
        service.accept(DOC_ID, CHG_CAS_ID, SPACE_ID, SPACE_ID, AUTHOR_ID),
      ).rejects.toThrow(ConflictException);

      expect(revertClaimedChanges).toHaveBeenCalledWith(
        SPACE_ID,
        [CHG_CAS_ID],
        'accepted',
      );
    });

    it('enforces author-only ownership on updateReply for non-author collaborators', async () => {
      const now = new Date();
      const THREAD_ID = '77777777-7777-4777-8777-777777777771';
      const REPLY_ID = '88888888-8888-4888-8888-888888888881';
      const threadRow = {
        id: THREAD_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        docId: DOC_ID,
        quote: 'Lemma 1',
        startLine: 0,
        startCol: 0,
        endLine: 0,
        endCol: 7,
        isResolved: false,
        createdById: AUTHOR_ID,
        resolvedById: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
        replies: [
          {
            id: REPLY_ID,
            threadId: THREAD_ID,
            content: 'Original note',
            createdById: AUTHOR_ID,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };

      const repoMock = {
        getPrisma: jest.fn().mockReturnValue({}),
        findThread: jest.fn().mockResolvedValue(threadRow),
        updateReply: jest.fn(),
      } as unknown as ReviewRepository;

      const scopeRepoMock = {
        findDocInProject: jest.fn().mockResolvedValue({
          id: DOC_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
        }),
        getPrisma: jest.fn().mockReturnValue({}),
      };
      const userResolverMock = {
        resolveUserNames: jest.fn().mockResolvedValue(new Map()),
      };
      const pageServiceMock = {
        resolveActiveProjectId: jest.fn().mockReturnValue(SPACE_ID),
        resolveProjectId: jest.fn().mockResolvedValue(SPACE_ID),
      };

      const service = new CommentsService(
        repoMock,
        scopeRepoMock as never,
        userResolverMock,
        pageServiceMock as never,
      );

      await expect(
        service.updateReply(
          DOC_ID,
          THREAD_ID,
          REPLY_ID,
          { content: 'Tampered text' },
          SPACE_ID,
          { user: { id: OTHER_USER_ID } } as never,
          SPACE_ID,
          Role.CONTRIBUTOR,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
