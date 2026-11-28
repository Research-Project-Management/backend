import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { PrismaService } from '@/core';
import { DocModifiedError } from '@/modules/pages/docstore';
import {
  ChangeNotFoundError,
  CommentsService,
  REVIEW_EVENTS,
  ResolvedThreadError,
  StaleAnchorError,
  SuggestionsService,
  ThreadNotFoundError,
  assertReviewTransitionAllowed,
  validateSuggestionRange,
} from '@/modules/pages/review';
import type { DocPatcher } from '@/modules/pages/review/adapters/doc-patcher.adapter';
import { TrackChange } from '@/modules/pages/review/domain/change.domain';
import { LinePatcher } from '@/modules/pages/review/domain/patcher.domain';
import {
  extractMentionUserIds,
  toSuggestionDto,
} from '@/modules/pages/review/domain/review.mapper';
import { TextRange } from '@/modules/pages/review/domain/text-range.domain';
import { ReviewRepository } from '@/modules/pages/review/review.repository';
import { Role } from '@/modules/project/access';
import {
  PAGES_REALTIME_DEFAULTS,
  PagesRealtimeConfigService,
  RealtimeValidationFailedException,
  YjsUpdateValidator,
} from '@/modules/realtime';
import { LiveCollaborationAdapter } from '@/modules/realtime/channels/pages/bridge';
import type { RoomPresenceStore } from '@/modules/realtime/channels/pages/presence';
import { YjsService } from '@/modules/realtime/channels/pages/yjs/engine';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_A_ID = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '44444444-4444-4444-8444-444444444444';
const AUTHOR_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';

describe('Pages Review, Track Changes & Live Doc Collaboration Seam', () => {
  describe('Domain errors, coordinate symmetry & review status transitions', () => {
    it('exposes HTTP status codes, converts 1-based UI <-> 0-based DB ranges symmetrically, and enforces transition RBAC', () => {
      expect(new DocModifiedError().statusCode).toBe(409);
      expect(new ChangeNotFoundError('chg-1').statusCode).toBe(404);
      expect(new ThreadNotFoundError('thr-1').statusCode).toBe(404);
      expect(new ResolvedThreadError('thr-1').statusCode).toBe(409);
      expect(new StaleAnchorError('chg-1').statusCode).toBe(409);

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
          ...dbRange,
          resolvedById: null,
          resolvedAt: null,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        } as never,
        new Map([[AUTHOR_ID, { id: AUTHOR_ID, name: 'Dr. Alice' }]]),
      );

      expect(dto).toMatchObject({
        fromLine: 2,
        toLine: 4,
        fromColumn: 3,
        toColumn: 9,
        suggestedText: 'added clause',
      });

      expect(() =>
        assertReviewTransitionAllowed({
          role: 'reviewer',
          fromStatus: 'in_review',
          toStatus: 'locked',
        }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('Live Yjs collaboration, non-mutating size guards & OCC 3-way merge', () => {
    let yjsService: YjsService | null = null;

    afterEach(async () => {
      if (yjsService) {
        await yjsService.onModuleDestroy();
        yjsService = null;
      }
    });

    it('rejects non-binary and oversized Yjs updates on a temporary doc BEFORE mutating active session', async () => {
      const validator = new YjsUpdateValidator();
      expect(() => validator.validateSyncPayload('base64-not-binary')).toThrow(
        RealtimeValidationFailedException,
      );

      yjsService = new YjsService(
        undefined,
        {
          getDoc: jest.fn().mockResolvedValue({
            id: DOC_ID,
            projectId: SPACE_ID,
            lines: ['\\section{Start}'],
            rev: 1,
            version: 1,
          }),
        } as never,
        validator,
        {
          getYjsConfig: () => ({
            ...PAGES_REALTIME_DEFAULTS.yjs,
            maxDocumentSizeBytes: 256,
            maxUpdateSizeBytes: 512 * 1024,
          }),
        } as PagesRealtimeConfigService,
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

    it('3-way merges on OCC conflict during flushDoc, emits doc:persisted ACK, and excludes failed flushes', async () => {
      const emitMock = jest.fn();
      const toMock = jest.fn().mockReturnValue({ emit: emitMock });
      const getDocMock = jest
        .fn()
        .mockResolvedValueOnce({
          id: DOC_ID,
          projectId: SPACE_ID,
          lines: ['line 1', 'line 2', 'line 3'],
          rev: 1,
          version: 1,
        })
        .mockResolvedValueOnce({
          id: DOC_ID,
          projectId: SPACE_ID,
          lines: ['remote line 1', 'line 2', 'line 3'],
          rev: 2,
          version: 2,
          deleted: false,
        });

      const updateDocMock = jest
        .fn()
        .mockRejectedValueOnce(new DocModifiedError())
        .mockResolvedValueOnce({
          rev: 3,
          version: 3,
          doc: { version: 3, rev: 3 },
        })
        .mockRejectedValueOnce(new Error('DB write unavailable'));

      yjsService = new YjsService(
        undefined,
        { getDoc: getDocMock, updateDoc: updateDocMock } as never,
        new YjsUpdateValidator(),
      );
      yjsService.setServer({ to: toMock } as never);

      const session = await yjsService.getOrCreateDoc(SPACE_ID, DOC_ID);
      session.doc.transact(() => {
        session.yText.delete(session.yText.length - 6, 6);
        session.yText.insert(session.yText.length, 'local line 3');
      }, 'sock-1');

      const adapter = new LiveCollaborationAdapter(
        yjsService,
        {} as RoomPresenceStore,
      );
      const flushedOnOcc = await adapter.flushDocs(SPACE_ID, [DOC_ID]);
      expect(flushedOnOcc).toEqual([DOC_ID]);
      expect(updateDocMock).toHaveBeenNthCalledWith(2, SPACE_ID, DOC_ID, {
        lines: ['remote line 1', 'line 2', 'local line 3'],
        version: 3,
        expectedRev: 2,
      });
      expect(yjsService.hasUnflushedChanges(SPACE_ID, DOC_ID)).toBe(false);
      expect(toMock).toHaveBeenCalledWith(`doc:${SPACE_ID}:${DOC_ID}`);
      expect(emitMock).toHaveBeenCalledWith(
        'doc:persisted',
        expect.objectContaining({
          spaceId: SPACE_ID,
          docId: DOC_ID,
          rev: 3,
          version: 3,
        }),
      );

      session.doc.transact(() => {
        session.yText.insert(session.yText.length, '\n% trailing');
      }, 'sock-1');
      expect(await adapter.flushDocs(SPACE_ID, [DOC_ID])).toEqual([]);
      expect(yjsService.hasUnflushedChanges(SPACE_ID, DOC_ID)).toBe(true);
    });
  });

  describe('Track changes anchor safety & CAS batch resolution', () => {
    it('throws StaleAnchorError when delete target is missing or ambiguous in nearby context', () => {
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

    it('reverts CAS-claimed pending change if DocPatcher fails, and resolves grouped replace pairs in one batch', async () => {
      const now = new Date();
      const CHG_CAS_ID = '66666666-6666-4666-8666-666666666661';
      const revertClaimedChanges = jest.fn().mockResolvedValue(undefined);
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

      const failingService = new SuggestionsService(
        {
          getPrisma: () => ({}),
          findChange: jest.fn().mockResolvedValue({
            id: CHG_CAS_ID,
            spaceId: SPACE_ID,
            pageId: PAGE_A_ID,
            docId: DOC_ID,
            type: 'delete',
            status: 'pending',
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
          }),
          claimPendingChanges: jest.fn().mockResolvedValue([CHG_CAS_ID]),
          revertClaimedChanges,
        } as unknown as ReviewRepository,
        {
          applyChange: jest
            .fn()
            .mockRejectedValue(new StaleAnchorError(CHG_CAS_ID)),
        } as unknown as DocPatcher,
        scopeRepoMock as never,
        userResolverMock,
        pageServiceMock as never,
      );

      await expect(
        failingService.accept(DOC_ID, CHG_CAS_ID, SPACE_ID, SPACE_ID, AUTHOR_ID),
      ).rejects.toThrow(ConflictException);
      expect(revertClaimedChanges).toHaveBeenCalledWith(
        SPACE_ID,
        [CHG_CAS_ID],
        'accepted',
      );

      // Grouped replace (delete + insert) resolved atomically
      const GROUP_ID = '99999999-9999-4999-8999-999999999990';
      const DEL_ID = '99999999-9999-4999-8999-999999999991';
      const INS_ID = '99999999-9999-4999-8999-999999999992';
      const deleteRow = {
        id: DEL_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        docId: DOC_ID,
        groupId: GROUP_ID,
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
      const applyBatch = jest.fn().mockResolvedValue({
        spaceId: SPACE_ID,
        lines: ['new'],
        version: 2,
        rev: 3,
      });

      const batchService = new SuggestionsService(
        {
          getPrisma: () => ({}),
          findChange: jest
            .fn()
            .mockResolvedValueOnce(deleteRow)
            .mockResolvedValueOnce({
              ...deleteRow,
              status: 'accepted',
              resolvedById: AUTHOR_ID,
            }),
          findPendingChangesByGroup: jest.fn().mockResolvedValue([
            TrackChange.create({
              id: DEL_ID,
              spaceId: SPACE_ID,
              pageId: PAGE_A_ID,
              docId: DOC_ID,
              groupId: GROUP_ID,
              type: 'delete',
              status: 'pending',
              text: 'old',
              range: TextRange.create({
                startLine: 0,
                startCol: 0,
                endLine: 0,
                endCol: 3,
              }),
              createdById: AUTHOR_ID,
              createdAt: now,
              updatedAt: now,
            }),
            TrackChange.create({
              id: INS_ID,
              spaceId: SPACE_ID,
              pageId: PAGE_A_ID,
              docId: DOC_ID,
              groupId: GROUP_ID,
              type: 'insert',
              status: 'pending',
              text: 'new',
              range: TextRange.create({
                startLine: 0,
                startCol: 3,
                endLine: 0,
                endCol: 6,
              }),
              createdById: AUTHOR_ID,
              createdAt: now,
              updatedAt: now,
            }),
          ]),
          claimPendingChanges: jest.fn().mockResolvedValue([DEL_ID, INS_ID]),
          revertClaimedChanges: jest.fn(),
        } as unknown as ReviewRepository,
        { applyBatch, applyChange: jest.fn() } as unknown as DocPatcher,
        scopeRepoMock as never,
        userResolverMock,
        pageServiceMock as never,
      );

      const res = await batchService.accept(
        DOC_ID,
        DEL_ID,
        SPACE_ID,
        SPACE_ID,
        AUTHOR_ID,
      );
      expect(applyBatch).toHaveBeenCalledTimes(1);
      expect((res as { resolvedIds?: string[] }).resolvedIds).toEqual([
        DEL_ID,
        INS_ID,
      ]);
    });
  });

  describe('Comment threads, security guards, @mentions & keyset pagination', () => {
    it('rejects cross-space docId spoofing, blocks locked reviews, and enforces author-only reply edits', async () => {
      const OTHER_SPACE_ID = '99999999-1111-4111-8111-111111111111';
      const THREAD_ID = '77777777-7777-4777-8777-777777777771';
      const REPLY_ID = '88888888-8888-4888-8888-888888888881';
      const now = new Date();

      // 1. Cross-space docId spoofing rejected
      const spoofService = new CommentsService(
        { getPrisma: () => ({}), saveThread: jest.fn() } as never,
        {
          findDocInProject: jest.fn().mockResolvedValue(null),
          getPrisma: () => ({}),
        } as never,
        { resolveUserNames: jest.fn().mockResolvedValue(new Map()) } as never,
        {
          resolveActiveProjectId: () => SPACE_ID,
          resolveProjectId: jest.fn().mockResolvedValue(OTHER_SPACE_ID),
        } as never,
      );
      await expect(
        spoofService.create(
          DOC_ID,
          { content: 'Cross-space spoof attempt', line: 1 },
          { user: { id: AUTHOR_ID } } as never,
          SPACE_ID,
          SPACE_ID,
        ),
      ).rejects.toThrow(NotFoundException);

      // 2. Locked review blocks create & addReply; non-author cannot updateReply
      let isLocked = true;
      const guardedService = new CommentsService(
        {
          getPrisma: () => ({}),
          findDocReview: jest.fn(async () =>
            isLocked
              ? { docId: DOC_ID, status: 'locked', currentRound: 1, version: 1 }
              : null,
          ),
          findThread: jest.fn().mockResolvedValue({
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
                commentId: THREAD_ID,
                content: 'Original note',
                createdById: AUTHOR_ID,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
          updateReply: jest.fn(),
        } as unknown as ReviewRepository,
        {
          findDocInProject: jest.fn().mockResolvedValue({
            id: DOC_ID,
            spaceId: SPACE_ID,
            pageId: PAGE_A_ID,
          }),
          getPrisma: () => ({}),
        } as never,
        { resolveUserNames: jest.fn().mockResolvedValue(new Map()) },
        {
          resolveActiveProjectId: () => SPACE_ID,
          resolveProjectId: async () => SPACE_ID,
        } as never,
      );

      await expect(
        guardedService.create(
          DOC_ID,
          { content: 'Locked note', line: 1 },
          { user: { id: AUTHOR_ID } } as never,
          SPACE_ID,
          SPACE_ID,
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        guardedService.addReply(
          DOC_ID,
          THREAD_ID,
          { content: 'Locked reply' },
          { user: { id: AUTHOR_ID } } as never,
          SPACE_ID,
          SPACE_ID,
        ),
      ).rejects.toThrow(ForbiddenException);

      isLocked = false;
      await expect(
        guardedService.updateReply(
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

    it('deduplicates @mentions, filters self-mentions on addReply, and diff-emits newly added mentions on updateReply', async () => {
      const PREV_USER = '11111111-1111-4111-8111-111111111119';
      expect(
        extractMentionUserIds(
          `Ping @[Alice](${AUTHOR_ID}) @[Bob](${OTHER_USER_ID.toUpperCase()}) @[Bob2](${OTHER_USER_ID}) @[Invalid](not-a-uuid)`,
        ),
      ).toEqual([AUTHOR_ID, OTHER_USER_ID]);

      const now = new Date();
      const THREAD_ID = '77777777-7777-4777-8777-777777777774';
      const REPLY_ID = '88888888-8888-4888-8888-888888888884';
      const emitMock = jest.fn();

      const service = new CommentsService(
        {
          getPrisma: () => ({}),
          findDocReview: jest.fn().mockResolvedValue(null),
          findThread: jest.fn().mockResolvedValue({
            id: THREAD_ID,
            spaceId: SPACE_ID,
            pageId: PAGE_A_ID,
            docId: DOC_ID,
            quote: 'Lemma 4',
            startLine: 1,
            startCol: 0,
            endLine: 1,
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
                commentId: THREAD_ID,
                content: `Existing mention @[Prev](${PREV_USER})`,
                createdById: AUTHOR_ID,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
          addReply: jest.fn().mockResolvedValue(undefined),
          updateReply: jest.fn().mockResolvedValue(true),
        } as unknown as ReviewRepository,
        {
          findDocInProject: jest.fn().mockResolvedValue({
            id: DOC_ID,
            spaceId: SPACE_ID,
            pageId: PAGE_A_ID,
          }),
          getPrisma: () => ({}),
        } as never,
        { resolveUserNames: jest.fn().mockResolvedValue(new Map()) },
        {
          resolveActiveProjectId: () => SPACE_ID,
          resolveProjectId: async () => SPACE_ID,
        } as never,
        { emit: emitMock } as never,
      );

      await service.addReply(
        DOC_ID,
        THREAD_ID,
        {
          content: `@[Self](${AUTHOR_ID}) check with @[Reviewer](${OTHER_USER_ID})`,
        },
        { user: { id: AUTHOR_ID } } as never,
        SPACE_ID,
        SPACE_ID,
      );
      expect(emitMock).toHaveBeenLastCalledWith('pages.project.event', {
        projectId: SPACE_ID,
        event: REVIEW_EVENTS.REPLY_ADDED,
        payload: expect.objectContaining({
          docId: DOC_ID,
          commentId: THREAD_ID,
          mentionedUserIds: [OTHER_USER_ID],
        }),
      });

      await service.updateReply(
        DOC_ID,
        THREAD_ID,
        REPLY_ID,
        {
          content: `Keep @[Prev](${PREV_USER}) and add @[New](${OTHER_USER_ID})`,
        },
        SPACE_ID,
        { user: { id: AUTHOR_ID } } as never,
        SPACE_ID,
        Role.CONTRIBUTOR,
      );
      expect(emitMock).toHaveBeenLastCalledWith('pages.project.event', {
        projectId: SPACE_ID,
        event: REVIEW_EVENTS.REPLY_UPDATED,
        payload: expect.objectContaining({
          mentionedUserIds: [OTHER_USER_ID],
        }),
      });
    });

    it('paginates resolved threads via keyset cursor (take = limit + 1) and clamps invalid cursors/limits', async () => {
      const makeRow = (id: string, createdAt: Date) => ({
        id,
        docId: DOC_ID,
        isResolved: true,
        resolvedById: null,
        resolvedAt: createdAt,
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 10,
        anchorStart: null,
        anchorEnd: null,
        baseDocRev: 1,
        createdById: AUTHOR_ID,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        doc: { spaceId: SPACE_ID, pageId: DOC_ID },
        replies: [],
      });

      const findMany = jest
        .fn()
        .mockResolvedValueOnce([
          makeRow(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            new Date('2026-11-23T10:00:00Z'),
          ),
          makeRow(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
            new Date('2026-11-23T09:00:00Z'),
          ),
          makeRow(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
            new Date('2026-11-23T08:00:00Z'),
          ),
        ])
        .mockResolvedValueOnce([
          makeRow(
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
            new Date('2026-11-23T07:00:00Z'),
          ),
        ])
        .mockResolvedValueOnce([]);

      const repo = new ReviewRepository({
        docComment: { findMany },
      } as unknown as PrismaService);

      const firstPage = await repo.listThreadsPaginated(SPACE_ID, DOC_ID, {
        isResolved: true,
        limit: 2,
      });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');

      const secondPage = await repo.listThreadsPaginated(SPACE_ID, DOC_ID, {
        isResolved: true,
        cursor: firstPage.nextCursor!,
        limit: 20,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.nextCursor).toBeNull();

      await repo.listThreadsPaginated(SPACE_ID, DOC_ID, {
        cursor: 'not-a-uuid',
        limit: 500,
      });
      const clampedArg = findMany.mock.calls[2][0] as Record<string, unknown>;
      expect(clampedArg.cursor).toBeUndefined();
      expect(clampedArg.take).toBe(101);
    });
  });
});
