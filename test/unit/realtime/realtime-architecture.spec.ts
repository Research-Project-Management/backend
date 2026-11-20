import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Server, Socket } from 'socket.io';
import {
  RealtimeException,
  RealtimeAccessDeniedException,
  RealtimeRateLimitedException,
} from '@/modules/realtime/core/ws-errors';
import { RealtimeConfigService } from '@/modules/realtime/core/realtime.config';
import { WsRateLimiter } from '@/modules/realtime/core/ws-rate-limiter';
import {
  PAGES_EVENTS,
  PAGES_ROOMS,
  classifyPagesEvent,
} from '@/modules/realtime/pages/pages.constants';
import { WsAccessGuard } from '@/modules/realtime/pages/access/ws-access.guard';
import { WS_ACCESS_LEVEL_KEY } from '@/modules/realtime/pages/access/ws-access.decorator';
import type { RealtimeAccessService } from '@/modules/realtime/pages/access/realtime-access.service';
import { LiveCollaborationAdapter } from '@/modules/realtime/pages/bridges/live-collab.adapter';
import { AccessRevocationListener } from '@/modules/realtime/pages/access/access-revocation.listener';
import type { PagesGateway } from '@/modules/realtime/pages/pages.gateway';
import type { RoomPresenceStore } from '@/modules/realtime/pages/presence/room-presence.store';
import type { YjsService } from '@/modules/realtime/pages/yjs/yjs.service';

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Realtime Module Standardized Architecture & Boundaries', () => {
  const realtimeRoot = path.resolve(__dirname, '../../../src/modules/realtime');
  const coreDir = path.join(realtimeRoot, 'core');

  describe('1. Static Boundary, Dead Code & Size Governance', () => {
    it('realtime/core has zero imports referencing ../pages, @/modules/pages, @/modules/project, or @/modules/chat', () => {
      const coreFiles = collectTsFiles(coreDir);
      expect(coreFiles.length).toBeGreaterThan(0);

      for (const filePath of coreFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(/from\s+['"]\.\.\/pages/);
        expect(content).not.toMatch(/from\s+['"]@\/modules\/pages/);
        expect(content).not.toMatch(/from\s+['"]@\/modules\/project/);
        expect(content).not.toMatch(/from\s+['"]@\/modules\/chat/);
      }
    });

    it('contains zero dead legacy doc:update / DOC_UPDATE references and every file is <= 550 lines', () => {
      const allFiles = collectTsFiles(realtimeRoot);
      expect(allFiles.length).toBeGreaterThan(0);

      for (const filePath of allFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(/['"]doc:update['"]/);
        expect(content).not.toMatch(/\bDOC_UPDATE\b/);
        const lineCount = content.split(/\r?\n/).length;
        expect(lineCount).toBeLessThanOrEqual(550);
      }
    });
  });

  describe('2. Domain-Agnostic WsRateLimiter with Custom Classifier', () => {
    it('throttles bursts using injected classifier and disconnects after consecutive throttled windows', () => {
      const config = fromPartial<RealtimeConfigService>({
        getRateLimits: () => ({
          cursor: { budgetPerSec: 1, burst: 1 },
          update: { budgetPerSec: 10, burst: 10 },
          chat: { budgetPerSec: 1, burst: 1 },
          joinLeave: { budgetPerSec: 1, burst: 1 },
          maxThrottledConsecutiveWindows: 2,
        }),
      });
      const limiter = new WsRateLimiter(config);
      const disconnect = jest.fn();
      const client = fromPartial<Socket>({
        id: 'sock-rate-1',
        disconnect,
      });

      const classifier = (ev: string) =>
        ev === 'custom:cursor' ? 'cursor' : 'other';

      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      try {
        // First event consumes burst token
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', classifier),
        ).not.toThrow();

        // Unclassified event bypasses limiter
        expect(() =>
          limiter.consumeOrThrow(client, 'unclassified:ping', classifier),
        ).not.toThrow();

        // Second cursor event in same second throws rate limit (window 1)
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', classifier),
        ).toThrow(RealtimeRateLimitedException);
        expect(disconnect).not.toHaveBeenCalled();

        // Next second refills 1 token; consuming a 2nd time in window 11 triggers disconnect
        dateSpy.mockReturnValue(11_000);
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', classifier),
        ).not.toThrow();
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', classifier),
        ).toThrow(RealtimeRateLimitedException);
        expect(disconnect).toHaveBeenCalledWith(true);
      } finally {
        dateSpy.mockRestore();
      }
    });
  });

  describe('3. PAGES_ROOMS SSOT & WsAccessGuard Rule Chain', () => {
    it('builds canonical room keys via PAGES_ROOMS and classifies pages events', () => {
      expect(PAGES_ROOMS.project('sp-1')).toBe('project:sp-1');
      expect(PAGES_ROOMS.doc('sp-1', 'doc-1')).toBe('doc:sp-1:doc-1');
      expect(classifyPagesEvent(PAGES_EVENTS.YJS_SYNC_UPDATE)).toBe('update');
      expect(classifyPagesEvent(PAGES_EVENTS.DOC_CURSOR)).toBe('cursor');
      expect(classifyPagesEvent('unknown')).toBe('other');
    });

    it('canonicalizes personal space alias on leave (@WsAccess none), and enforces read/write & anti-IDOR rules', async () => {
      const userId = '11111111-1111-4111-8111-111111111111';
      const spaceId = '22222222-2222-4222-8222-222222222222';
      const otherSpaceId = '33333333-3333-4333-8333-333333333333';
      const docId = '44444444-4444-4444-8444-444444444444';

      const reflector = new Reflector();
      const realtimeAccess = fromPartial<RealtimeAccessService>({
        checkAccess: jest.fn(async (_sp, _u, level) =>
          level === 'write' ? 'denied' : 'allowed',
        ),
        validateDocInProject: jest.fn(async () => true),
        resolveCanonicalSpaceAndPage: jest.fn(async (raw: string) => ({
          spaceId: raw,
        })),
      });
      const guard = new WsAccessGuard(reflector, realtimeAccess);

      const makeContext = (
        event: string,
        accessLevel: 'none' | 'member' | 'read' | 'write',
        data: Record<string, unknown>,
        socketData: Record<string, unknown>,
      ): ExecutionContext => {
        const handler = () => undefined;
        Reflect.defineMetadata(MESSAGE_METADATA, event, handler);
        Reflect.defineMetadata(WS_ACCESS_LEVEL_KEY, accessLevel, handler);
        return {
          getHandler: () => handler,
          getClass: () => class DummyGateway {},
          switchToWs: () => ({
            getClient: () =>
              fromPartial<Socket>({ id: 'sock-1', data: socketData }),
            getData: () => data,
          }),
        } as unknown as ExecutionContext;
      };

      // 1. Personal alias normalization still happens for @WsAccess('none')
      const leavePayload: Record<string, unknown> = { spaceId: 'personal' };
      const leaveCtx = makeContext(
        PAGES_EVENTS.PROJECT_LEAVE,
        'none',
        leavePayload,
        { userId, authenticated: true },
      );
      await expect(guard.canActivate(leaveCtx)).resolves.toBe(true);
      expect(leavePayload.spaceId).toBe(userId);

      // 2. Anti-IDOR blocks payload spaceId mismatch on doc sync
      const idorCtx = makeContext(
        PAGES_EVENTS.YJS_SYNC_STEP_1,
        'read',
        { spaceId: otherSpaceId, docId },
        { userId, authenticated: true, spaceId, activeDocId: docId },
      );
      await expect(guard.canActivate(idorCtx)).rejects.toThrow(
        RealtimeAccessDeniedException,
      );

      // 3. Reviewer write action throws ROLE_INSUFFICIENT
      const writeCtx = makeContext(
        PAGES_EVENTS.YJS_SYNC_UPDATE,
        'write',
        { spaceId, docId },
        { userId, authenticated: true, spaceId, activeDocId: docId },
      );
      await expect(guard.canActivate(writeCtx)).rejects.toMatchObject({
        code: 'ROLE_INSUFFICIENT',
      } satisfies Partial<RealtimeException>);
    });
  });

  describe('4. LiveCollaborationAdapter & Room-Scoped AccessRevocationListener', () => {
    it('LiveCollaborationAdapter.applyExternalText emits { spaceId, docId, data } to PAGES_ROOMS.doc(spaceId, docId)', async () => {
      const frame = Buffer.from([1, 2, 3]);
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      const gateway = fromPartial<PagesGateway>({
        server: fromPartial<Server>({ to }),
      });
      const yjs = fromPartial<YjsService>({
        applyExternalTextAndSyncRedis: jest
          .fn()
          .mockResolvedValue({ active: true, frame }),
      });
      const rooms = fromPartial<RoomPresenceStore>({});

      const adapter = new LiveCollaborationAdapter(yjs, rooms, gateway);
      const ok = await adapter.applyExternalText(
        'sp-1',
        'doc-1',
        'updated text',
      );

      expect(ok).toBe(true);
      expect(to).toHaveBeenCalledWith(PAGES_ROOMS.doc('sp-1', 'doc-1'));
      expect(emit).toHaveBeenCalledWith(PAGES_EVENTS.YJS_SYNC_UPDATE, {
        spaceId: 'sp-1',
        docId: 'doc-1',
        data: frame,
      });
    });

    it('AccessRevocationListener scopes socket fetch to PAGES_ROOMS.project(spaceId) and evicts matching socket', async () => {
      const leave = jest.fn();
      const emit = jest.fn();
      const targetSocket = {
        id: 'sock-revoked',
        data: { userId: 'user-1', spaceId: 'sp-1', activeDocId: 'doc-1' },
        emit,
        leave,
      };
      const fetchSockets = jest.fn().mockResolvedValue([targetSocket]);
      const serverIn = jest.fn(() => ({ fetchSockets }));

      const gateway = fromPartial<PagesGateway>({
        server: fromPartial<Server>({
          in: serverIn,
          sockets: { adapter: { rooms: new Map() } } as never,
        }),
        broadcastToDoc: jest.fn(),
        broadcastToProject: jest.fn(),
      });
      const realtimeAccess = fromPartial<RealtimeAccessService>({
        evictCache: jest.fn(),
      });
      const roomStore = fromPartial<RoomPresenceStore>({
        removeProjectSession: jest.fn().mockResolvedValue(null),
      });
      const yjs = fromPartial<YjsService>({
        evictDoc: jest.fn().mockResolvedValue(undefined),
      });

      const listener = new AccessRevocationListener(
        realtimeAccess,
        gateway,
        roomStore,
        yjs,
      );

      await listener.handleMemberRemoved({
        projectId: 'sp-1',
        userId: 'user-1',
      });

      expect(serverIn).toHaveBeenCalledWith(PAGES_ROOMS.project('sp-1'));
      expect(fetchSockets).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(PAGES_EVENTS.ACCESS_REVOKED, {
        spaceId: 'sp-1',
      });
      expect(leave).toHaveBeenCalledWith(PAGES_ROOMS.project('sp-1'));
      expect(leave).toHaveBeenCalledWith(PAGES_ROOMS.doc('sp-1', 'doc-1'));
      expect(yjs.evictDoc).toHaveBeenCalledWith('sp-1', 'doc-1');
    });
  });
});
