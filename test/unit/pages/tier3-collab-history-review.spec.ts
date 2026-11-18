import { ForbiddenException } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { DocModifiedError } from '@/modules/pages/docstore/domain/doc.errors';
import {
  validateSuggestionRange,
  formatSuggestionItemDto,
} from '@/modules/pages/docstore/controllers/review.helpers';
import { YjsUpdateValidator } from '@/modules/realtime/pages/yjs-update-validator';
import { YjsService } from '@/modules/realtime/pages/yjs.service';
import { RealtimeValidationFailedException } from '@/modules/realtime/core/ws-errors';
import type { RealtimeConfigService } from '@/modules/realtime/core/realtime.config';
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
  ManuscriptHistoryMapper,
  ProjectHistoryRepository,
} from '@/modules/pages/project-history/project-history.repository';
import { ProjectHistoryService } from '@/modules/pages/project-history/project-history.service';
import type {
  ManuscriptCollectorAdapter,
  ManuscriptRestorerAdapter,
} from '@/modules/pages/project-history/adapters/project-history.adapters';
import {
  LinePatcher,
  TrackChange,
  CommentThread,
  CommentReply,
  TextRangeVo,
  ChangeNotFoundException,
  ThreadNotFoundException,
  ResolvedThreadException,
  StaleTrackChangeAnchorException,
} from '@/modules/pages/track-changes/domain';
import type { TrackChangesRepository } from '@/modules/pages/track-changes/track-changes.repository';
import { TrackChangesService } from '@/modules/pages/track-changes/track-changes.service';
import type { DocstorePatcherAdapter } from '@/modules/pages/track-changes/adapters/track-changes.adapters';
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
      expect(new ChangeNotFoundException('chg-1').statusCode).toBe(404);
      expect(new ThreadNotFoundException('thr-1').statusCode).toBe(404);
      expect(new ResolvedThreadException('thr-1').statusCode).toBe(409);
      expect(new StaleTrackChangeAnchorException('chg-1').statusCode).toBe(409);
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
      const dto = formatSuggestionItemDto(
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
      const configMock: Partial<RealtimeConfigService> = {
        getMaxDocumentSizeBytes: () => 256,
        getMaxYjsUpdateSizeBytes: () => 512 * 1024,
      };
      yjsService = new YjsService(
        undefined,
        docstoreMock as never,
        new YjsUpdateValidator(),
        configMock as RealtimeConfigService,
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
    it('preserves canonical spaceId and pageId across ManuscriptHistoryMapper and Snapshot/VersionLabel entities', () => {
      const now = new Date('2026-10-01T12:00:00Z');
      const snap = ManuscriptHistoryMapper.toDomainHeader({
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
      } as unknown as ManuscriptCollectorAdapter;

      const mockRestorer = {
        restoreSingleFileToState: jest.fn().mockResolvedValue({
          path: '/chapter1.tex',
          docId: DOC_ID,
          fileId: null,
          content: 'Restored line',
          rev: 12,
        }),
      } as unknown as ManuscriptRestorerAdapter;

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
    it('throws StaleTrackChangeAnchorException (409) when delete text is missing or ambiguous in nearby context', () => {
      const missingChange = TrackChange.create({
        id: 'chg-missing',
        projectId: SPACE_ID,
        docId: DOC_ID,
        type: 'delete',
        text: 'obsolete phrase',
        range: TextRangeVo.create({
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
      ).toThrow(StaleTrackChangeAnchorException);

      const ambiguousChange = TrackChange.create({
        id: 'chg-ambiguous',
        projectId: SPACE_ID,
        docId: DOC_ID,
        type: 'delete',
        text: 'dup',
        range: TextRangeVo.create({
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
      ).toThrow(StaleTrackChangeAnchorException);
    });

    it('atomically claims pending change via CAS and reverts claim if DocstorePatcher fails', async () => {
      const pendingChange = TrackChange.create({
        id: 'chg-cas',
        projectId: SPACE_ID,
        pageId: PAGE_A_ID,
        docId: DOC_ID,
        type: 'delete',
        text: 'old',
        range: TextRangeVo.create({
          startLine: 0,
          startCol: 0,
          endLine: 0,
          endCol: 3,
        }),
      });

      const revertClaimedChangesStatus = jest.fn().mockResolvedValue(1);
      const repoMock = {
        findChangeById: jest.fn().mockResolvedValue(pendingChange),
        claimPendingChanges: jest.fn().mockResolvedValue([pendingChange]),
        revertClaimedChangesStatus,
      } as unknown as TrackChangesRepository;

      const patcherMock = {
        applyChange: jest
          .fn()
          .mockRejectedValue(new StaleTrackChangeAnchorException('chg-cas')),
      } as unknown as DocstorePatcherAdapter;

      const docstoreMock = {
        getDocById: jest.fn().mockResolvedValue({
          id: DOC_ID,
          projectId: SPACE_ID,
          pageId: PAGE_A_ID,
          deleted: false,
        }),
      };

      const service = new TrackChangesService(
        repoMock,
        docstoreMock as never,
        patcherMock,
      );

      await expect(
        service.acceptChange(SPACE_ID, DOC_ID, 'chg-cas', AUTHOR_ID),
      ).rejects.toThrow(StaleTrackChangeAnchorException);

      expect(revertClaimedChangesStatus).toHaveBeenCalledWith(
        SPACE_ID,
        DOC_ID,
        ['chg-cas'],
        'accepted',
      );
      expect(pendingChange.status).toBe('pending');
    });

    it('enforces author-only ownership on updateCommentReply for non-author collaborators', async () => {
      const thread = CommentThread.create({
        id: 'thr-1',
        projectId: SPACE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        docId: DOC_ID,
        quote: 'Lemma 1',
        range: TextRangeVo.create({
          startLine: 0,
          startCol: 0,
          endLine: 0,
          endCol: 7,
        }),
        createdById: AUTHOR_ID,
        replies: [
          CommentReply.create({
            id: 'rep-1',
            threadId: 'thr-1',
            content: 'Original note',
            createdById: AUTHOR_ID,
          }),
        ],
      });

      const repoMock = {
        findThreadById: jest.fn().mockResolvedValue(thread),
        updateCommentReply: jest.fn(),
      } as unknown as TrackChangesRepository;

      const service = new TrackChangesService(repoMock);

      await expect(
        service.updateCommentReply(
          SPACE_ID,
          DOC_ID,
          'thr-1',
          'rep-1',
          'Tampered text',
          OTHER_USER_ID,
          Role.CONTRIBUTOR,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
