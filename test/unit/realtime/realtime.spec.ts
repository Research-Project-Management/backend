import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Server, Socket } from 'socket.io';
import {
  GlobalExceptionFilter,
  PrismaService,
  type RedisCacheService,
} from '@/core';
import {
  CHAT_REALTIME_DEFAULTS,
  ChatRealtimeConfigService,
  PAGES_DOMAIN_EVENTS,
  PAGES_EVENTS,
  PAGES_REALTIME_DEFAULTS,
  PAGES_REDIS_CHANNELS,
  PAGES_REDIS_KEYS,
  PAGES_ROOMS,
  PagesRealtimeConfigService,
  REALTIME_BUS_CHANNEL,
  REALTIME_CORE_DEFAULTS,
  REALTIME_INTERNAL_KEY_HEADER,
  REALTIME_NAMESPACES,
  RealtimeAccessDeniedException,
  RealtimeConfigService,
  RealtimeControlClient,
  RealtimeEventBus,
  type RealtimeException,
  RealtimeFacade,
  RealtimeInternalAuthGuard,
  RealtimeRateLimitedException,
  RemoteLiveCollaborationAdapter,
  WORK_ITEMS_REALTIME_DEFAULTS,
  WorkItemsRealtimeConfigService,
  WsAccess,
  WsAccessGuard,
  type WsAccessLevel,
  WsRateLimiter,
  type WsRateLimitPolicy,
  classifyPagesEvent,
  emitToLocalRoom,
  evictUserFromRoom,
  formatConversationRoom,
  formatDocRoom,
  formatProjectRoom,
  formatUserRoom,
  isSocketInRoom,
  resolveRealtimeInternalKey,
} from '@/modules/realtime';
import { PagesEventsPublisher } from '@/modules/realtime/adapters/pages';
import type { RealtimeAccessService } from '@/modules/realtime/channels/pages/access';
import {
  AccessRevocationListener,
  LiveCollaborationAdapter,
} from '@/modules/realtime/channels/pages/bridge';
import type { PagesGateway } from '@/modules/realtime/channels/pages/gateway';
import type { RoomPresenceStore } from '@/modules/realtime/channels/pages/presence';
import type { YjsService } from '@/modules/realtime/channels/pages/yjs/engine';
import { RealtimeServiceAppModule } from '@/realtime.module';

const REALTIME_ROOT = path.resolve(__dirname, '../../../src/modules/realtime');

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

function extractModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const regex =
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    specs.push(match[1]);
  }
  return specs;
}

describe('Realtime Platform & Standalone Service Seam', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('Module import boundaries', () => {
    it('keeps core, ports, and domain-extracted channels decoupled from domain implementations', () => {
      const violations: string[] = [];

      for (const dirName of ['core', 'ports']) {
        for (const filePath of collectTsFiles(
          path.join(REALTIME_ROOT, dirName),
        )) {
          const rel = path.relative(REALTIME_ROOT, filePath).replace(/\\/g, '/');
          for (const spec of extractModuleSpecifiers(
            fs.readFileSync(filePath, 'utf8'),
          )) {
            if (
              /^(\.\.\/)+(pages|channels|adapters)(\/|$)/.test(spec) ||
              /^@\/modules\/(pages|project|chat)(\/|$)/.test(spec)
            ) {
              violations.push(`${rel} -> ${spec}`);
            }
          }
        }
      }

      for (const channelName of ['chat', 'work-items']) {
        for (const filePath of collectTsFiles(
          path.join(REALTIME_ROOT, 'channels', channelName),
        )) {
          const rel = path.relative(REALTIME_ROOT, filePath).replace(/\\/g, '/');
          for (const spec of extractModuleSpecifiers(
            fs.readFileSync(filePath, 'utf8'),
          )) {
            if (
              /^(\.\.\/)+adapters(\/|$)/.test(spec) ||
              /^@\/modules\/(pages|project|chat)(\/|$)/.test(spec)
            ) {
              violations.push(`${rel} -> ${spec}`);
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe('Rooms, rate limiting, configs & RealtimeEventBus', () => {
    it('formats canonical room keys, emits to local rooms, and evicts matching user sockets only', async () => {
      expect(REALTIME_NAMESPACES).toEqual({
        PAGES: '/pages',
        CHAT: '/chat',
        WORK_ITEMS: '/work-items',
      });
      expect(formatProjectRoom('sp-1')).toBe('project:sp-1');
      expect(formatDocRoom('sp-1', 'doc-1')).toBe('doc:sp-1:doc-1');
      expect(formatUserRoom('u-1')).toBe('user:u-1');
      expect(formatConversationRoom('c-1')).toBe('conv:c-1');
      expect(PAGES_ROOMS.project('sp-1')).toBe('project:sp-1');
      expect(PAGES_ROOMS.doc('sp-1', 'doc-1')).toBe('doc:sp-1:doc-1');
      expect(PAGES_REDIS_CHANNELS.YJS_CLUSTER).toBe('page:crdt:cluster');
      expect(PAGES_REDIS_KEYS.yjsBinary('sp', 'doc')).toBe(
        'page:crdt:bin:sp:doc',
      );
      expect(classifyPagesEvent(PAGES_EVENTS.YJS_SYNC_UPDATE)).toBe('update');
      expect(classifyPagesEvent(PAGES_EVENTS.DOC_CURSOR)).toBe('cursor');
      expect(classifyPagesEvent('unknown')).toBeNull();

      const sock = fromPartial<Socket>({
        rooms: new Set(['project:p1', 'conv:c1']),
      });
      expect(isSocketInRoom(sock, 'project:p1')).toBe(true);
      expect(isSocketInRoom(sock, 'project:p2')).toBe(false);

      const leaveTarget = jest.fn();
      const emitTarget = jest.fn();
      const leaveOther = jest.fn();
      const emitOther = jest.fn();
      const mockSrv = fromPartial<Server>({
        in: jest.fn(() => ({
          fetchSockets: jest.fn().mockResolvedValue([
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
          ]),
        })) as never,
      });

      expect(
        await evictUserFromRoom(
          mockSrv,
          'project:p1',
          'u-kick',
          'access:revoked',
          { projectId: 'p1' },
        ),
      ).toBe(1);
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
      const localSrv = fromPartial<Server>({
        local: fromPartial<Server>({ to: localTo as never }) as never,
      });
      emitToLocalRoom(localSrv, ['user:u1'], 'conversation:updated', {
        id: 'c1',
      });
      expect(localTo).toHaveBeenCalledWith(['user:u1']);
      expect(localEmit).toHaveBeenCalledWith('conversation:updated', {
        id: 'c1',
      });

      localTo.mockClear();
      emitToLocalRoom(localSrv, [], 'conversation:updated', {});
      expect(localTo).not.toHaveBeenCalled();
    });

    it('dispatches RealtimeEventBus events in-process, via Redis Pub/Sub, and in publisher-only mode', async () => {
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
      const subHandlers: Record<string, (...args: unknown[]) => void> = {};
      const mockSubClient = {
        on: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
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
      const redisBus = new RealtimeEventBus(
        fromPartial<RedisCacheService>({
          isReady: () => true,
          getClient: () => mockPubClient as never,
        }),
      );
      await redisBus.onModuleInit();
      const receivedRedis: unknown[] = [];
      redisBus.subscribe((env) => {
        receivedRedis.push(env);
      });
      await redisBus.publish({
        type: 'member:removed',
        projectId: 'p1',
        userId: 'u9',
      });
      expect(receivedRedis).toEqual([
        { type: 'member:removed', projectId: 'p1', userId: 'u9' },
      ]);
      await redisBus.onModuleDestroy();
      expect(mockSubClient.quit).toHaveBeenCalled();

      // 3. Publisher mode skips Redis subscription when Redis is ready, falls back locally when not ready
      const pubOnlyPublish = jest.fn().mockResolvedValue(1);
      const pubOnlyDuplicate = jest.fn();
      const pubBus = new RealtimeEventBus(
        fromPartial<RedisCacheService>({
          isReady: () => true,
          getClient: () => ({
            duplicate: pubOnlyDuplicate,
            publish: pubOnlyPublish,
          }),
        }),
        'publisher',
      );
      const localHandler = jest.fn();
      pubBus.subscribe(localHandler);
      await pubBus.onModuleInit();
      expect(pubOnlyDuplicate).not.toHaveBeenCalled();

      await pubBus.publish({
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.FILE_TREE_UPDATE,
        payload: { action: 'create', node: { id: 'n1' } },
      });
      expect(pubOnlyPublish).toHaveBeenCalledWith(
        REALTIME_BUS_CHANNEL,
        expect.any(String),
      );
      expect(localHandler).not.toHaveBeenCalled();

      const offlinePubBus = new RealtimeEventBus(
        fromPartial<RedisCacheService>({ isReady: () => false }),
        'publisher',
      );
      offlinePubBus.subscribe(localHandler);
      await offlinePubBus.publish({
        type: 'member:removed',
        projectId: 'proj-2',
        userId: 'user-9',
      });
      expect(localHandler).toHaveBeenCalledWith({
        type: 'member:removed',
        projectId: 'proj-2',
        userId: 'user-9',
      });
    });

    it('throttles bursts via WsRateLimiter and resolves Core/Pages/Chat/WorkItems config overrides', () => {
      const envValues: Record<string, string> = {
        REALTIME_MAX_MESSAGE_SIZE_BYTES: '2097152',
        REALTIME_RATE_MAX_THROTTLED_WINDOWS: '2',
        REALTIME_MAX_DOCUMENT_SIZE_BYTES: '1048576',
        PAGES_REALTIME_YJS_FLUSH_DEBOUNCE_MS: '750',
        REALTIME_RATE_CHAT_BUDGET: '12',
        WORK_ITEMS_RATE_JOIN_LEAVE_BUDGET: '8',
      };
      const mockConfig = fromPartial<ConfigService>({
        get: <T = string>(key: string) => envValues[key] as T,
      });

      expect(
        new RealtimeConfigService().getTransportConfig().maxMessageSizeBytes,
      ).toBe(REALTIME_CORE_DEFAULTS.transport.maxMessageSizeBytes);

      const coreConfig = new RealtimeConfigService(mockConfig);
      const pagesConfig = new PagesRealtimeConfigService(
        mockConfig,
        coreConfig,
      );
      const chatConfig = new ChatRealtimeConfigService(mockConfig, coreConfig);
      const workItemsConfig = new WorkItemsRealtimeConfigService(
        mockConfig,
        coreConfig,
      );

      expect(coreConfig.getTransportConfig().maxMessageSizeBytes).toBe(
        2_097_152,
      );
      expect(pagesConfig.getYjsConfig().maxDocumentSizeBytes).toBe(1_048_576);
      expect(pagesConfig.getYjsConfig().flushDebounceMs).toBe(750);
      expect(pagesConfig.getPresenceConfig().sessionTtlSeconds).toBe(
        PAGES_REALTIME_DEFAULTS.presence.sessionTtlSeconds,
      );
      expect(chatConfig.getRateLimitBudgets().message.budgetPerSec).toBe(12);
      expect(chatConfig.getRateLimitPolicy().budgets.message.burst).toBe(
        CHAT_REALTIME_DEFAULTS.rateLimits.message.burst,
      );
      expect(workItemsConfig.getRateLimitBudgets().joinLeave.budgetPerSec).toBe(
        8,
      );
      expect(workItemsConfig.getRateLimitBudgets().joinLeave.burst).toBe(
        WORK_ITEMS_REALTIME_DEFAULTS.rateLimits.joinLeave.burst,
      );

      const limiter = new WsRateLimiter(coreConfig);
      const disconnect = jest.fn();
      const client = fromPartial<Socket>({ id: 'sock-rate-1', disconnect });
      const policy: WsRateLimitPolicy = {
        classify: (ev) => (ev === 'custom:cursor' ? 'custom_cursor' : null),
        budgets: { custom_cursor: { budgetPerSec: 1, burst: 1 } },
      };

      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      expect(() =>
        limiter.consumeOrThrow(client, 'custom:cursor', policy),
      ).not.toThrow();
      expect(() =>
        limiter.consumeOrThrow(client, 'unclassified:ping', policy),
      ).not.toThrow();
      expect(() =>
        limiter.consumeOrThrow(client, 'custom:cursor', policy),
      ).toThrow(RealtimeRateLimitedException);
      expect(disconnect).not.toHaveBeenCalled();

      dateSpy.mockReturnValue(11_000);
      expect(() =>
        limiter.consumeOrThrow(client, 'custom:cursor', policy),
      ).not.toThrow();
      expect(() =>
        limiter.consumeOrThrow(client, 'custom:cursor', policy),
      ).toThrow(RealtimeRateLimitedException);
      expect(disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('WsAccessGuard, LiveCollaborationAdapter & AccessRevocationListener', () => {
    it('normalizes personal space alias, blocks cross-space IDOR, and rejects insufficient write role', async () => {
      const userId = '11111111-1111-4111-8111-111111111111';
      const spaceId = '22222222-2222-4222-8222-222222222222';
      const otherSpaceId = '33333333-3333-4333-8333-333333333333';
      const docId = '44444444-4444-4444-8444-444444444444';

      const guard = new WsAccessGuard(
        new Reflector(),
        fromPartial<RealtimeAccessService>({
          checkAccess: jest.fn(async (_sp, _u, level) =>
            level === 'write' ? 'denied' : 'allowed',
          ),
          validateDocInProject: jest.fn(async () => true),
          resolveCanonicalSpaceAndPage: jest.fn(async (raw: string) => ({
            spaceId: raw,
          })),
        }),
      );

      const makeContext = (
        event: string,
        accessLevel: WsAccessLevel,
        data: Record<string, unknown>,
        socketData: Record<string, unknown>,
      ): ExecutionContext => {
        const handler = () => undefined;
        Reflect.defineMetadata(MESSAGE_METADATA, event, handler);
        Reflect.defineMetadata(WsAccess(accessLevel).KEY, accessLevel, handler);
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

      const leavePayload: Record<string, unknown> = { spaceId: 'personal' };
      await expect(
        guard.canActivate(
          makeContext(PAGES_EVENTS.PROJECT_LEAVE, 'none', leavePayload, {
            userId,
            authenticated: true,
          }),
        ),
      ).resolves.toBe(true);
      expect(leavePayload.spaceId).toBe(userId);

      await expect(
        guard.canActivate(
          makeContext(
            PAGES_EVENTS.YJS_SYNC_STEP_1,
            'read',
            { spaceId: otherSpaceId, docId },
            { userId, authenticated: true, spaceId, activeDocId: docId },
          ),
        ),
      ).rejects.toThrow(RealtimeAccessDeniedException);

      await expect(
        guard.canActivate(
          makeContext(
            PAGES_EVENTS.YJS_SYNC_UPDATE,
            'write',
            { spaceId, docId },
            { userId, authenticated: true, spaceId, activeDocId: docId },
          ),
        ),
      ).rejects.toMatchObject({
        code: 'ROLE_INSUFFICIENT',
      } satisfies Partial<RealtimeException>);
    });

    it('emits external Yjs text updates to doc room and evicts revoked members from project/doc rooms', async () => {
      const frame = Buffer.from([1, 2, 3]);
      const emitDoc = jest.fn();
      const toDoc = jest.fn(() => ({ emit: emitDoc }));
      const adapter = new LiveCollaborationAdapter(
        fromPartial<YjsService>({
          applyExternalTextAndSyncRedis: jest
            .fn()
            .mockResolvedValue({ active: true, frame }),
        }),
        fromPartial<RoomPresenceStore>({}),
        fromPartial<PagesGateway>({
          server: fromPartial<Server>({ to: toDoc }),
        }),
      );

      expect(
        await adapter.applyExternalText('sp-1', 'doc-1', 'updated text'),
      ).toBe(true);
      expect(toDoc).toHaveBeenCalledWith(PAGES_ROOMS.doc('sp-1', 'doc-1'));
      expect(emitDoc).toHaveBeenCalledWith(PAGES_EVENTS.YJS_SYNC_UPDATE, {
        spaceId: 'sp-1',
        docId: 'doc-1',
        data: frame,
      });

      const leave = jest.fn();
      const emitRevoked = jest.fn();
      const evictDoc = jest.fn().mockResolvedValue(undefined);
      const serverIn = jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([
          {
            id: 'sock-revoked',
            data: { userId: 'user-1', spaceId: 'sp-1', activeDocId: 'doc-1' },
            emit: emitRevoked,
            leave,
          },
        ]),
      }));

      const listener = new AccessRevocationListener(
        fromPartial<RealtimeAccessService>({ evictCache: jest.fn() }),
        fromPartial<PagesGateway>({
          server: fromPartial<Server>({
            in: serverIn,
            sockets: { adapter: { rooms: new Map() } } as never,
          }),
          broadcastToDoc: jest.fn(),
          broadcastToProject: jest.fn(),
        }),
        fromPartial<RoomPresenceStore>({
          removeProjectSession: jest.fn().mockResolvedValue(null),
        }),
        fromPartial<YjsService>({ evictDoc }),
      );

      await listener.handleMemberRemoved({
        projectId: 'sp-1',
        userId: 'user-1',
      });
      expect(serverIn).toHaveBeenCalledWith(PAGES_ROOMS.project('sp-1'));
      expect(emitRevoked).toHaveBeenCalledWith(PAGES_EVENTS.ACCESS_REVOKED, {
        spaceId: 'sp-1',
      });
      expect(leave).toHaveBeenCalledWith(PAGES_ROOMS.project('sp-1'));
      expect(leave).toHaveBeenCalledWith(PAGES_ROOMS.doc('sp-1', 'doc-1'));
      expect(evictDoc).toHaveBeenCalledWith('sp-1', 'doc-1');
    });
  });

  describe('Internal auth, control client, event publishers & RealtimeFacade', () => {
    it('derives and verifies X-Internal-Key with timingSafeEqual and fails closed in production', () => {
      const createHttpContext = (
        headers: Record<string, string | string[] | undefined>,
      ): ExecutionContext =>
        fromPartial<ExecutionContext>({
          switchToHttp: () => ({ getRequest: () => ({ headers }) }),
        });

      delete process.env.REALTIME_INTERNAL_API_KEY;
      delete process.env.JWT_SECRET;
      expect(resolveRealtimeInternalKey()).toBe('');

      process.env.JWT_SECRET = 'jwt-secret-123';
      const derived = createHmac('sha256', 'jwt-secret-123')
        .update('flux:realtime:internal')
        .digest('hex');
      expect(resolveRealtimeInternalKey()).toBe(derived);

      const guard = new RealtimeInternalAuthGuard();
      expect(
        guard.canActivate(
          createHttpContext({ [REALTIME_INTERNAL_KEY_HEADER]: derived }),
        ),
      ).toBe(true);
      expect(() => guard.canActivate(createHttpContext({}))).toThrow(
        UnauthorizedException,
      );
      expect(() =>
        guard.canActivate(
          createHttpContext({ [REALTIME_INTERNAL_KEY_HEADER]: 'wrong-key' }),
        ),
      ).toThrow(UnauthorizedException);

      process.env.REALTIME_INTERNAL_API_KEY = 'explicit-internal-key';
      expect(resolveRealtimeInternalKey()).toBe('explicit-internal-key');

      delete process.env.REALTIME_INTERNAL_API_KEY;
      delete process.env.JWT_SECRET;
      const prodGuard = new RealtimeInternalAuthGuard(
        fromPartial<ConfigService>({
          get: (key: string) => (key === 'NODE_ENV' ? 'production' : undefined),
        }),
      );
      expect(() => prodGuard.canActivate(createHttpContext({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('calls internal endpoints via RealtimeControlClient, degrades safely on failure, and forwards domain events', async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ flushedDocIds: ['doc-1', 'doc-2'] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ active: true }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ evicted: true }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            users: [
              {
                id: 'sock-1',
                userId: 'user-1',
                name: 'Alice',
                color: '#3B82F6',
                avatar: null,
                fileId: 'doc-1',
                cursor: { lineNumber: 2, column: 4 },
                lastSeen: 1000,
              },
            ],
          }),
        })
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const client = new RealtimeControlClient(undefined, {
        baseUrl: 'http://flux_realtime:3014/',
        internalKey: 'secret-key-1',
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      const remoteCollab = new RemoteLiveCollaborationAdapter(client);

      expect(client.getBaseUrl()).toBe('http://flux_realtime:3014');
      expect(
        await remoteCollab.flushDocs('proj-1', ['doc-1', 'doc-2']),
      ).toEqual(['doc-1', 'doc-2']);
      expect(await remoteCollab.applyExternalText('proj-1', 'doc-1', '')).toBe(
        true,
      );
      await remoteCollab.evictDoc('proj-1', 'doc-1');

      const presence = await remoteCollab.getPresence('proj-1', 'doc-1');
      expect(presence[0].userId).toBe('user-1');
      const getCallArgs = fetchFn.mock.calls[3] as [
        string,
        { headers: Record<string, string> },
      ];
      expect(getCallArgs[1].headers['Content-Type']).toBeUndefined();
      expect(await remoteCollab.flushDocs('proj-1', [])).toEqual([]);

      // PagesEventsPublisher & Client-Mode RealtimeFacade
      const publish = jest.fn().mockResolvedValue(undefined);
      const bus = fromPartial<RealtimeEventBus>({ publish });
      const publisher = new PagesEventsPublisher(bus);

      await publisher.handleFileTreeChangeEvent({
        projectId: 'proj-1',
        change: { action: 'rename', node: { id: 'f1' } },
      });
      await publisher.handleProjectEvent({
        projectId: 'proj-1',
        event: PAGES_EVENTS.HISTORY_NEW_VERSION,
        payload: { version: 3 },
      });
      await publisher.handleMemberUpdated({
        projectId: 'proj-1',
        targetUserId: 'user-2',
        newRole: 'reviewer',
      });
      await publisher.handleOwnershipTransferred({
        projectId: 'proj-1',
        previousOwnerId: 'user-1',
        newOwnerId: 'user-2',
      });
      await publisher.handleProjectDeleted({ entityId: 'proj-1' });
      expect(publish).toHaveBeenCalledTimes(5);
      expect(PAGES_DOMAIN_EVENTS.PROJECT_EVENT).toBe('pages.project.event');

      const facade = new RealtimeFacade(
        undefined,
        undefined,
        undefined,
        bus,
        fromPartial<RealtimeControlClient>({
          flushDocs: jest.fn().mockResolvedValue(['doc-1', 'doc-2']),
          getPresence: jest.fn().mockResolvedValue([
            {
              id: 'sock-1',
              userId: 'user-1',
              name: 'Alice',
              color: '#EF4444',
              avatar: null,
              fileId: 'doc-1',
              cursor: null,
              lastSeen: 12345,
            },
          ]),
        }),
      );

      expect(await facade.flushProject('proj-1')).toBe(2);
      facade.broadcastCompileProgress('proj-1', { status: 'compiling' });
      expect(publish).toHaveBeenLastCalledWith({
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.COMPILE_PROGRESS,
        payload: { status: 'compiling' },
      });
      expect(await facade.getProjectPresence('proj-1')).toHaveLength(1);
      expect(await facade.getDocPresence('proj-1', 'doc-1')).toHaveLength(1);
    });
  });

  describe('RealtimeServiceAppModule HTTP control plane', () => {
    let app: NestFastifyApplication;
    let derivedKey: string;

    beforeAll(async () => {
      process.env.DISABLE_REDIS = 'true';
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'test-realtime-secret';
      delete process.env.REALTIME_INTERNAL_API_KEY;
      derivedKey = resolveRealtimeInternalKey();

      const moduleRef = await Test.createTestingModule({
        imports: [RealtimeServiceAppModule],
      })
        .overrideProvider(PrismaService)
        .useValue({
          $connect: jest.fn(),
          $disconnect: jest.fn(),
          $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
          onModuleInit: jest.fn(),
          onModuleDestroy: jest.fn(),
        })
        .compile();

      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: false,
          stopAtFirstError: true,
        }),
      );
      app.useGlobalFilters(new GlobalExceptionFilter());
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('exposes health & authenticated /internal/realtime/* endpoints without REST API controllers', async () => {
      const rootRes = await app.inject({ method: 'GET', url: '/' });
      expect(rootRes.statusCode).toBe(200);
      expect(JSON.parse(rootRes.body)).toMatchObject({
        status: 'ok',
        service: 'flux-realtime',
        namespaces: expect.arrayContaining(Object.values(REALTIME_NAMESPACES)),
      });

      const healthRes = await app.inject({
        method: 'GET',
        url: '/health/liveness',
      });
      expect(healthRes.statusCode).toBe(200);

      const unauthFlush = await app.inject({
        method: 'POST',
        url: '/internal/realtime/flush',
        payload: { projectId: 'proj-1' },
      });
      expect(unauthFlush.statusCode).toBe(401);

      const authFlush = await app.inject({
        method: 'POST',
        url: '/internal/realtime/flush',
        headers: { [REALTIME_INTERNAL_KEY_HEADER]: derivedKey },
        payload: { projectId: 'proj-1', docIds: [] },
      });
      expect(authFlush.statusCode).toBe(200);
      expect(JSON.parse(authFlush.body)).toEqual({ flushedDocIds: [] });

      const emptyTextRes = await app.inject({
        method: 'POST',
        url: '/internal/realtime/apply-text',
        headers: { [REALTIME_INTERNAL_KEY_HEADER]: derivedKey },
        payload: { projectId: 'proj-1', docId: 'doc-1', text: '' },
      });
      expect(emptyTextRes.statusCode).toBe(200);
      expect(JSON.parse(emptyTextRes.body)).toEqual({ active: false });

      const apiRouteRes = await app.inject({
        method: 'GET',
        url: '/api/chat/conversations',
      });
      expect(apiRouteRes.statusCode).toBe(404);
    });
  });
});
