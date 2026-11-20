import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Server, Socket } from 'socket.io';
import type { ConfigService } from '@nestjs/config';
import {
  RealtimeException,
  RealtimeAccessDeniedException,
  RealtimeRateLimitedException,
} from '@/modules/realtime/core/errors';
import {
  REALTIME_CORE_DEFAULTS,
  REALTIME_NAMESPACES,
  RealtimeConfigService,
} from '@/modules/realtime/core/config';
import {
  formatProjectRoom,
  formatDocRoom,
  formatUserRoom,
  formatConversationRoom,
  isSocketInRoom,
  emitToLocalRoom,
  evictUserFromRoom,
} from '@/modules/realtime/core/rooms';
import { RealtimeEventBus, REALTIME_BUS_CHANNEL } from '@/modules/realtime';
import type { RedisCacheService } from '@/core';
import {
  WsRateLimiter,
  type WsRateLimitPolicy,
} from '@/modules/realtime/core/rate-limit';
import {
  PAGES_REALTIME_DEFAULTS,
  PagesRealtimeConfigService,
  PAGES_EVENTS,
  PAGES_ROOMS,
  PAGES_REDIS_KEYS,
  PAGES_REDIS_CHANNELS,
  PAGES_DOMAIN_EVENTS,
  classifyPagesEvent,
} from '@/modules/realtime/channels/pages/config';
import {
  ChatRealtimeConfigService,
  CHAT_REALTIME_DEFAULTS,
} from '@/modules/realtime/channels/chat/config';
import {
  WorkItemsRealtimeConfigService,
  WORK_ITEMS_REALTIME_DEFAULTS,
} from '@/modules/realtime/channels/work-items/config';
import { CHAT_CACHE_DEFAULTS } from '@/modules/chat/services/chat-cache.service';
import {
  WS_ACCESS_LEVEL_KEY,
  WsAccessGuard,
} from '@/modules/realtime/channels/pages/guard';
import type { RealtimeAccessService } from '@/modules/realtime/channels/pages/access';
import {
  LiveCollaborationAdapter,
  AccessRevocationListener,
} from '@/modules/realtime/channels/pages/bridge';
import type { PagesGateway } from '@/modules/realtime/channels/pages/gateway';
import type { RoomPresenceStore } from '@/modules/realtime/channels/pages/presence';
import type { YjsService } from '@/modules/realtime/channels/pages/yjs/engine';

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

  describe('1. Static Boundary, Service Extraction & Size Governance', () => {
    it('enforces strict standalone service boundaries across core, ports, and extracted channels', () => {
      for (const dirName of ['core', 'ports']) {
        const dirPath = path.join(realtimeRoot, dirName);
        const files = collectTsFiles(dirPath);
        expect(files.length).toBeGreaterThan(0);

        for (const filePath of files) {
          const content = fs.readFileSync(filePath, 'utf8');
          expect(content).not.toMatch(/from\s+['"](\.\.\/)+pages/);
          expect(content).not.toMatch(/from\s+['"](\.\.\/)+channels/);
          expect(content).not.toMatch(/from\s+['"](\.\.\/)+adapters/);
          expect(content).not.toMatch(/from\s+['"]@\/modules\/pages/);
          expect(content).not.toMatch(/from\s+['"]@\/modules\/project/);
          expect(content).not.toMatch(/from\s+['"]@\/modules\/chat/);
        }
      }

      for (const channelName of ['chat', 'work-items']) {
        const channelDir = path.join(realtimeRoot, 'channels', channelName);
        const files = collectTsFiles(channelDir);
        expect(files.length).toBeGreaterThan(0);

        for (const filePath of files) {
          const content = fs.readFileSync(filePath, 'utf8');
          expect(content).not.toMatch(/from\s+['"](\.\.\/)+adapters/);
          expect(content).not.toMatch(/from\s+['"]@\/modules\/chat/);
          expect(content).not.toMatch(/from\s+['"]@\/modules\/project/);
          expect(content).not.toMatch(/from\s+['"]@\/modules\/pages/);
        }
      }
    });

    it('removes legacy fragmented folders, domain-owned gateways, and redundant Editor SSE stream', () => {
      for (const removedCore of [
        'realtime.namespaces.ts',
        'realtime.config.ts',
        'realtime-health.service.ts',
        'ws-auth.service.ts',
        'ws-connection.middleware.ts',
        'ws-errors.ts',
        'ws-exception.filter.ts',
        'ws-rate-limiter.ts',
        'rate-limiter.ts',
        'room.util.ts',
        'core.module.ts',
      ]) {
        expect(fs.existsSync(path.join(coreDir, removedCore))).toBe(false);
      }

      // Old locations must stay deleted after centralizing and cleaning up names
      expect(fs.existsSync(path.join(realtimeRoot, 'pages'))).toBe(false);
      expect(fs.existsSync(path.join(realtimeRoot, 'transport'))).toBe(false);
      expect(
        fs.existsSync(
          path.resolve(__dirname, '../../../src/modules/chat/gateways'),
        ),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.resolve(
            __dirname,
            '../../../src/modules/chat/chat-realtime.config.ts',
          ),
        ),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.resolve(
            __dirname,
            '../../../src/modules/project/work-item/realtime',
          ),
        ),
      ).toBe(false);

      const pagesChannelDir = path.join(realtimeRoot, 'channels', 'pages');
      for (const removedPagesDir of [
        'access',
        'bridges',
        'chat',
        'dto',
        'presence',
        'domain',
        'services',
        'stores',
      ]) {
        expect(fs.existsSync(path.join(pagesChannelDir, removedPagesDir))).toBe(
          false,
        );
      }

      for (const yjsFile of [
        'cluster.ts',
        'engine.ts',
        'merge.ts',
        'persistence.ts',
        'sync.ts',
      ]) {
        expect(fs.existsSync(path.join(pagesChannelDir, 'yjs', yjsFile))).toBe(
          true,
        );
      }

      const coreConfigContent = fs.readFileSync(
        path.join(coreDir, 'config.ts'),
        'utf8',
      );
      const rateLimitContent = fs.readFileSync(
        path.join(coreDir, 'rate-limit.ts'),
        'utf8',
      );
      for (const content of [coreConfigContent, rateLimitContent]) {
        expect(content).not.toMatch(/MAX_YJS_UPDATE/);
        expect(content).not.toMatch(/MAX_DOCUMENT_SIZE/);
        expect(content).not.toMatch(/AUTH_CACHE/);
        expect(content).not.toMatch(/['"]cursor['"]/);
        expect(content).not.toMatch(/['"]joinLeave['"]/);
      }

      const chatGatewayPath = path.join(
        realtimeRoot,
        'channels',
        'chat',
        'gateway.ts',
      );
      const chatGatewayContent = fs.readFileSync(chatGatewayPath, 'utf8');
      expect(chatGatewayContent).toContain('createWsCorsOptions()');
      expect(chatGatewayContent).toContain('WsAllExceptionsFilter');
      expect(chatGatewayContent).toContain('ValidationPipe');
      expect(chatGatewayContent).toContain('WsRateLimiter');
      expect(chatGatewayContent).not.toMatch(/this\.server\.emit\s*\(/);
      expect(chatGatewayContent).not.toMatch(/isOriginAllowed/);

      const workItemsGatewayPath = path.join(
        realtimeRoot,
        'channels',
        'work-items',
        'gateway.ts',
      );
      const workItemsGatewayContent = fs.readFileSync(
        workItemsGatewayPath,
        'utf8',
      );
      expect(workItemsGatewayContent).toContain('createWsCorsOptions()');
      expect(workItemsGatewayContent).toContain('WsAllExceptionsFilter');
      expect(workItemsGatewayContent).toContain('ValidationPipe');
      expect(workItemsGatewayContent).toContain('WsRateLimiter');
      expect(workItemsGatewayContent).toContain(
        'REALTIME_NAMESPACES.WORK_ITEMS',
      );
      expect(workItemsGatewayContent).not.toMatch(/this\.server\.emit\s*\(/);
      expect(workItemsGatewayContent).not.toMatch(/isOriginAllowed/);

      const workItemCoreControllerPath = path.resolve(
        __dirname,
        '../../../src/modules/project/work-item/core/core.controller.ts',
      );
      const workItemCoreControllerContent = fs.readFileSync(
        workItemCoreControllerPath,
        'utf8',
      );
      expect(workItemCoreControllerContent).not.toMatch(/@Sse\s*\(/);
      expect(workItemCoreControllerContent).not.toContain('work-items/events');

      const presenceControllerContent = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/modules/pages/docstore/controllers/presence.controller.ts',
        ),
        'utf8',
      );
      const presenceServiceContent = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/modules/pages/docstore/services/presence.service.ts',
        ),
        'utf8',
      );
      const frontendReviewClientContent = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../../frontend/src/features/editor/sdk/pages/review.client.ts',
        ),
        'utf8',
      );
      for (const sseFreeContent of [
        presenceControllerContent,
        presenceServiceContent,
        frontendReviewClientContent,
      ]) {
        expect(sseFreeContent).not.toContain('collaboration/stream');
        expect(sseFreeContent).not.toContain('createCollaborationStream');
      }
      expect(presenceServiceContent).not.toContain('streamPresenceAndUpdates');
    });

    it('keeps channels/pages free of messaging/chat coupling (owned by channels/chat)', () => {
      const pagesDir = path.join(realtimeRoot, 'channels', 'pages');
      expect(fs.existsSync(path.join(pagesDir, 'chat.ts'))).toBe(false);

      for (const filePath of collectTsFiles(pagesDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(/project:chat:/);
        expect(content).not.toMatch(/PagesChatService/);
        expect(content).not.toMatch(/prisma\.conversation/);
        expect(content).not.toMatch(/prisma\.message\b/);
      }
    });

    it('contains zero dead legacy doc:update / DOC_UPDATE or manuscript references and every file is <= 550 lines', () => {
      const allFiles = collectTsFiles(realtimeRoot);
      expect(allFiles.length).toBeGreaterThan(0);

      for (const filePath of allFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(/['"]doc:update['"]/);
        expect(content).not.toMatch(/\bDOC_UPDATE\b/);
        expect(content).not.toMatch(/manuscript/i);
        const lineCount = content.split(/\r?\n/).length;
        expect(lineCount).toBeLessThanOrEqual(550);
      }

      expect(REALTIME_NAMESPACES.PAGES).toBe('/pages');
      expect(REALTIME_NAMESPACES.CHAT).toBe('/chat');
      expect(REALTIME_NAMESPACES.WORK_ITEMS).toBe('/work-items');
      expect(formatProjectRoom('sp-1')).toBe('project:sp-1');
      expect(formatDocRoom('sp-1', 'doc-1')).toBe('doc:sp-1:doc-1');
      expect(formatUserRoom('u-1')).toBe('user:u-1');
      expect(formatConversationRoom('c-1')).toBe('conv:c-1');
      expect(PAGES_REDIS_CHANNELS.YJS_CLUSTER).toBe('page:crdt:cluster');
      expect(PAGES_REDIS_KEYS.yjsBinary('sp', 'doc')).toBe(
        'page:crdt:bin:sp:doc',
      );
      expect(PAGES_DOMAIN_EVENTS.PROJECT_EVENT).toBe('pages.project.event');

      const frontendSocketFile = path.resolve(
        __dirname,
        '../../../../frontend/src/features/editor/sdk/realtime/yjs-inbound-events.ts',
      );
      const frontendSocketContent = fs.readFileSync(frontendSocketFile, 'utf8');
      expect(frontendSocketContent).toContain('/pages');
      expect(frontendSocketContent).not.toMatch(/['"`]\/manuscripts['"`]/);
    });
  });

  describe('2. Domain-Agnostic WsRateLimiter & room.util Helpers', () => {
    it('evaluates isSocketInRoom and evictUserFromRoom across matching remote sockets only', async () => {
      const sock = fromPartial<Socket>({
        rooms: new Set(['project:p1', 'conv:c1']),
      });
      expect(isSocketInRoom(sock, 'project:p1')).toBe(true);
      expect(isSocketInRoom(sock, 'project:p2')).toBe(false);

      const leaveTarget = jest.fn();
      const emitTarget = jest.fn();
      const leaveOther = jest.fn();
      const emitOther = jest.fn();
      const fetchSockets = jest.fn().mockResolvedValue([
        {
          id: 's1',
          data: { userId: 'u-kick' },
          emit: emitTarget,
          leave: leaveTarget,
        },
        {
          id: 's2',
          data: { userId: 'u-stay' },
          emit: emitOther,
          leave: leaveOther,
        },
      ]);
      const mockSrv = fromPartial<Server>({
        in: jest.fn(() => ({ fetchSockets })) as never,
      });

      const evicted = await evictUserFromRoom(
        mockSrv,
        'project:p1',
        'u-kick',
        'access:revoked',
        { projectId: 'p1' },
      );

      expect(evicted).toBe(1);
      expect(emitTarget).toHaveBeenCalledWith('access:revoked', {
        projectId: 'p1',
      });
      expect(leaveTarget).toHaveBeenCalledWith('project:p1');
      expect(emitOther).not.toHaveBeenCalled();
      expect(leaveOther).not.toHaveBeenCalled();
      expect(await evictUserFromRoom(undefined, 'project:p1', 'u-kick')).toBe(
        0,
      );

      const localEmit = jest.fn();
      const localTo = jest.fn(() => ({ emit: localEmit }));
      emitToLocalRoom(
        fromPartial<Server>({
          local: fromPartial<Server>({ to: localTo as never }) as never,
        }),
        ['user:u1', 'user:u2'],
        'conversation:updated',
        { id: 'c1' },
      );
      expect(localTo).toHaveBeenCalledWith(['user:u1', 'user:u2']);
      expect(localEmit).toHaveBeenCalledWith('conversation:updated', {
        id: 'c1',
      });

      localTo.mockClear();
      emitToLocalRoom(
        fromPartial<Server>({
          local: fromPartial<Server>({ to: localTo as never }) as never,
        }),
        [],
        'conversation:updated',
        {},
      );
      expect(localTo).not.toHaveBeenCalled();
    });

    it('dispatches RealtimeEventBus events in-process by default and via Redis Pub/Sub when Redis is ready', async () => {
      // 1. In-process fallback without Redis
      const localBus = new RealtimeEventBus();
      await localBus.onModuleInit();
      const receivedLocal: unknown[] = [];
      localBus.subscribe((env) => {
        receivedLocal.push(env);
      });
      await localBus.publish({
        type: 'chat:reaction',
        conversationId: 'c1',
        payload: {
          conversationId: 'c1',
          messageId: 'm1',
          userId: 'u1',
          emoji: '🔥',
          action: 'add',
        },
      });
      expect(receivedLocal).toHaveLength(1);
      await localBus.onModuleDestroy();

      // 2. Cross-process Redis Pub/Sub path
      const subHandlers: Record<string, (...args: any[]) => void> = {};
      const mockSubClient = {
        on: jest.fn((event: string, fn: (...args: any[]) => void) => {
          subHandlers[event] = fn;
        }),
        subscribe: jest.fn().mockResolvedValue(1),
        quit: jest.fn().mockResolvedValue('OK'),
      };
      const mockPubClient = {
        duplicate: jest.fn(() => mockSubClient),
        publish: jest.fn(async (channel: string, raw: string) => {
          subHandlers.message?.(channel, raw);
          return 1;
        }),
      };
      const mockRedis = fromPartial<RedisCacheService>({
        isReady: () => true,
        getClient: () => mockPubClient as never,
      });

      const redisBus = new RealtimeEventBus(mockRedis);
      await redisBus.onModuleInit();
      expect(mockSubClient.subscribe).toHaveBeenCalledWith(
        REALTIME_BUS_CHANNEL,
      );

      const receivedRedis: unknown[] = [];
      redisBus.subscribe((env) => {
        receivedRedis.push(env);
      });

      await redisBus.publish({
        type: 'member:removed',
        projectId: 'p1',
        userId: 'u9',
      });
      expect(mockPubClient.publish).toHaveBeenCalledWith(
        REALTIME_BUS_CHANNEL,
        JSON.stringify({
          type: 'member:removed',
          projectId: 'p1',
          userId: 'u9',
        }),
      );
      expect(receivedRedis).toEqual([
        { type: 'member:removed', projectId: 'p1', userId: 'u9' },
      ]);
      await redisBus.onModuleDestroy();
      expect(mockSubClient.quit).toHaveBeenCalled();
    });

    it('throttles bursts using injected policy and disconnects after consecutive throttled windows from RealtimeConfigService', () => {
      const config = fromPartial<RealtimeConfigService>({
        getRateLimiterConfig: () => ({
          ...REALTIME_CORE_DEFAULTS.rateLimiter,
          maxThrottledConsecutiveWindows: 2,
        }),
      });
      const limiter = new WsRateLimiter(config);
      const disconnect = jest.fn();
      const client = fromPartial<Socket>({
        id: 'sock-rate-1',
        disconnect,
      });

      const policy: WsRateLimitPolicy = {
        classify: (ev) => (ev === 'custom:cursor' ? 'custom_cursor' : null),
        budgets: {
          custom_cursor: { budgetPerSec: 1, burst: 1 },
        },
      };

      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      try {
        // First event consumes burst token
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', policy),
        ).not.toThrow();

        // Unclassified event bypasses limiter
        expect(() =>
          limiter.consumeOrThrow(client, 'unclassified:ping', policy),
        ).not.toThrow();

        // Second cursor event in same second throws rate limit (window 1)
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', policy),
        ).toThrow(RealtimeRateLimitedException);
        expect(disconnect).not.toHaveBeenCalled();

        // Next second refills 1 token; consuming a 2nd time in window 11 triggers disconnect
        dateSpy.mockReturnValue(11_000);
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', policy),
        ).not.toThrow();
        expect(() =>
          limiter.consumeOrThrow(client, 'custom:cursor', policy),
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
      expect(classifyPagesEvent('unknown')).toBeNull();
    });

    it('provides separated defaults and env overrides across Core, Pages, Chat, and Work Items realtime configs', () => {
      const envValues: Record<string, string> = {
        REALTIME_MAX_MESSAGE_SIZE_BYTES: '2097152',
        REALTIME_RATE_MAX_THROTTLED_WINDOWS: '9',
        REALTIME_MAX_DOCUMENT_SIZE_BYTES: '1048576',
        PAGES_REALTIME_YJS_FLUSH_DEBOUNCE_MS: '750',
        REALTIME_RATE_CHAT_BUDGET: '12',
        WORK_ITEMS_RATE_JOIN_LEAVE_BUDGET: '8',
      };
      const mockConfig = fromPartial<ConfigService>({
        get: <T = string>(key: string) => envValues[key] as T,
      });

      const defaultCore = new RealtimeConfigService();
      expect(defaultCore.getTransportConfig().maxMessageSizeBytes).toBe(
        REALTIME_CORE_DEFAULTS.transport.maxMessageSizeBytes,
      );

      const coreConfig = new RealtimeConfigService(mockConfig);
      expect(coreConfig.getTransportConfig().maxMessageSizeBytes).toBe(
        2_097_152,
      );
      expect(
        coreConfig.getRateLimiterConfig().maxThrottledConsecutiveWindows,
      ).toBe(9);

      const pagesConfig = new PagesRealtimeConfigService(
        mockConfig,
        coreConfig,
      );
      expect(pagesConfig.getYjsConfig().maxDocumentSizeBytes).toBe(1_048_576);
      expect(pagesConfig.getYjsConfig().flushDebounceMs).toBe(750);
      expect(pagesConfig.getPresenceConfig().sessionTtlSeconds).toBe(
        PAGES_REALTIME_DEFAULTS.presence.sessionTtlSeconds,
      );
      expect(
        pagesConfig.getRateLimitPolicy().maxThrottledConsecutiveWindows,
      ).toBe(9);

      const chatConfig = new ChatRealtimeConfigService(mockConfig, coreConfig);
      expect(chatConfig.getRateLimitBudgets().message.budgetPerSec).toBe(12);
      expect(
        chatConfig.getRateLimitPolicy().maxThrottledConsecutiveWindows,
      ).toBe(9);
      expect(chatConfig.getRateLimitPolicy().classify('message:send')).toBe(
        'message',
      );
      expect(chatConfig.getRateLimitPolicy().budgets.message.burst).toBe(
        CHAT_REALTIME_DEFAULTS.rateLimits.message.burst,
      );
      expect(CHAT_CACHE_DEFAULTS.maxCachedMessages).toBe(50);

      const workItemsConfig = new WorkItemsRealtimeConfigService(
        mockConfig,
        coreConfig,
      );
      expect(workItemsConfig.getRateLimitBudgets().joinLeave.budgetPerSec).toBe(
        8,
      );
      expect(workItemsConfig.getRateLimitBudgets().joinLeave.burst).toBe(
        WORK_ITEMS_REALTIME_DEFAULTS.rateLimits.joinLeave.burst,
      );
      expect(
        workItemsConfig.getRateLimitPolicy().maxThrottledConsecutiveWindows,
      ).toBe(9);
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
