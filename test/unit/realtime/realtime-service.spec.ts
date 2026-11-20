import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import {
  GlobalExceptionFilter,
  PrismaService,
  type RedisCacheService,
} from '@/core';
import {
  REALTIME_BUS_CHANNEL,
  REALTIME_INTERNAL_KEY_HEADER,
  REALTIME_NAMESPACES,
  RealtimeControlClient,
  RealtimeEventBus,
  RealtimeFacade,
  RealtimeInternalAuthGuard,
  RemoteLiveCollaborationAdapter,
  resolveRealtimeInternalKey,
} from '@/modules/realtime';
import { PagesEventsPublisher } from '@/modules/realtime/adapters/pages';
import {
  PAGES_DOMAIN_EVENTS,
  PAGES_EVENTS,
} from '@/modules/realtime/channels/pages/config';
import { RealtimeServiceAppModule } from '@/realtime.module';

describe('Standalone Realtime Microservice (port 3014)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('1. RealtimeEventBus Publisher vs Subscriber Mode', () => {
    it('does not subscribe in publisher mode and always publishes to Redis channel when ready', async () => {
      const duplicate = jest.fn();
      const publish = jest.fn().mockResolvedValue(1);
      const mockRedis = fromPartial<RedisCacheService>({
        isReady: () => true,
        getClient: () => ({ duplicate, publish }),
      });

      const bus = new RealtimeEventBus(mockRedis, 'publisher');
      expect(bus.getMode()).toBe('publisher');

      const localHandler = jest.fn();
      bus.subscribe(localHandler);

      await bus.onModuleInit();
      expect(duplicate).not.toHaveBeenCalled();

      await bus.publish({
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.FILE_TREE_UPDATE,
        payload: { action: 'create', node: { id: 'n1' } },
      });

      expect(publish).toHaveBeenCalledWith(
        REALTIME_BUS_CHANNEL,
        JSON.stringify({
          type: 'pages:project-event',
          projectId: 'proj-1',
          event: PAGES_EVENTS.FILE_TREE_UPDATE,
          payload: { action: 'create', node: { id: 'n1' } },
        }),
      );
      expect(localHandler).not.toHaveBeenCalled();
    });

    it('falls back to local dispatch in publisher mode when Redis is not ready', async () => {
      const mockRedis = fromPartial<RedisCacheService>({
        isReady: () => false,
      });
      const bus = new RealtimeEventBus(mockRedis, 'publisher');
      const localHandler = jest.fn();
      bus.subscribe(localHandler);

      await bus.publish({
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
  });

  describe('2. Internal API Key Resolution & Auth Guard', () => {
    const createHttpContext = (
      headers: Record<string, string | string[] | undefined>,
    ): ExecutionContext =>
      fromPartial<ExecutionContext>({
        switchToHttp: () => ({
          getRequest: () => ({ headers }),
        }),
      });

    it('uses explicit REALTIME_INTERNAL_API_KEY first, else HMAC-SHA256(JWT_SECRET)', () => {
      delete process.env.REALTIME_INTERNAL_API_KEY;
      delete process.env.JWT_SECRET;
      expect(resolveRealtimeInternalKey()).toBe('');

      process.env.JWT_SECRET = 'jwt-secret-123';
      const derived = createHmac('sha256', 'jwt-secret-123')
        .update('flux:realtime:internal')
        .digest('hex');
      expect(resolveRealtimeInternalKey()).toBe(derived);

      process.env.REALTIME_INTERNAL_API_KEY = 'explicit-internal-key';
      expect(resolveRealtimeInternalKey()).toBe('explicit-internal-key');
    });

    it('validates X-Internal-Key with timingSafeEqual and fails closed in production when unset', () => {
      delete process.env.REALTIME_INTERNAL_API_KEY;
      process.env.JWT_SECRET = 'guard-secret';
      const expected = resolveRealtimeInternalKey();
      const guard = new RealtimeInternalAuthGuard();

      expect(
        guard.canActivate(
          createHttpContext({ [REALTIME_INTERNAL_KEY_HEADER]: expected }),
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

      const prodConfig = fromPartial<ConfigService>({
        get: (key: string) => (key === 'NODE_ENV' ? 'production' : undefined),
      });
      delete process.env.JWT_SECRET;
      const prodGuard = new RealtimeInternalAuthGuard(prodConfig);
      expect(() => prodGuard.canActivate(createHttpContext({}))).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('3. RealtimeControlClient & RemoteLiveCollaborationAdapter', () => {
    it('calls internal endpoints with X-Internal-Key, skips Content-Type on GET, and degrades safely on failure', async () => {
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
      const adapter = new RemoteLiveCollaborationAdapter(client);

      expect(client.getBaseUrl()).toBe('http://flux_realtime:3014');

      const flushed = await adapter.flushDocs('proj-1', ['doc-1', 'doc-2']);
      expect(flushed).toEqual(['doc-1', 'doc-2']);
      expect(fetchFn).toHaveBeenNthCalledWith(
        1,
        'http://flux_realtime:3014/internal/realtime/flush',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [REALTIME_INTERNAL_KEY_HEADER]: 'secret-key-1',
          },
          body: JSON.stringify({
            projectId: 'proj-1',
            docIds: ['doc-1', 'doc-2'],
          }),
        }),
      );

      const applied = await adapter.applyExternalText('proj-1', 'doc-1', '');
      expect(applied).toBe(true);

      await adapter.evictDoc('proj-1', 'doc-1');
      expect(fetchFn).toHaveBeenNthCalledWith(
        3,
        'http://flux_realtime:3014/internal/realtime/evict-doc',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'proj-1', docId: 'doc-1' }),
        }),
      );

      const presence = await adapter.getPresence('proj-1', 'doc-1');
      expect(presence).toHaveLength(1);
      expect(presence[0].userId).toBe('user-1');
      const getCallArgs = fetchFn.mock.calls[3] as [
        string,
        { headers: Record<string, string> },
      ];
      expect(getCallArgs[0]).toBe(
        'http://flux_realtime:3014/internal/realtime/presence?projectId=proj-1&docId=doc-1',
      );
      expect(getCallArgs[1].headers['Content-Type']).toBeUndefined();

      // Network failure must return safe fallback [] instead of throwing
      expect(await adapter.flushDocs('proj-1', [])).toEqual([]);
    });
  });

  describe('4. PagesEventsPublisher & Client-Mode RealtimeFacade', () => {
    it('forwards pages & membership domain events onto RealtimeEventBus', async () => {
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
      expect(publish).toHaveBeenNthCalledWith(1, {
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.FILE_TREE_UPDATE,
        payload: { action: 'rename', node: { id: 'f1' } },
      });
      expect(publish).toHaveBeenNthCalledWith(2, {
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.HISTORY_NEW_VERSION,
        payload: { version: 3 },
      });
      expect(publish).toHaveBeenNthCalledWith(3, {
        type: 'member:updated',
        projectId: 'proj-1',
        userId: 'user-2',
        role: 'reviewer',
      });
      expect(publish).toHaveBeenNthCalledWith(4, {
        type: 'ownership:transferred',
        projectId: 'proj-1',
        previousOwnerId: 'user-1',
        newOwnerId: 'user-2',
      });
      expect(publish).toHaveBeenNthCalledWith(5, {
        type: 'project:deleted',
        projectId: 'proj-1',
      });
      expect(PAGES_DOMAIN_EVENTS.PROJECT_EVENT).toBe('pages.project.event');
    });

    it('proxies RealtimeFacade flush, broadcasts, and presence lookups when gateways/Yjs are absent (client mode)', async () => {
      const busPublish = jest.fn().mockResolvedValue(undefined);
      const mockBus = fromPartial<RealtimeEventBus>({ publish: busPublish });
      const mockClient = fromPartial<RealtimeControlClient>({
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
      });

      const facade = new RealtimeFacade(
        undefined,
        undefined,
        undefined,
        mockBus,
        mockClient,
      );

      expect(await facade.flushProject('proj-1')).toBe(2);

      facade.broadcastFileTreeChange('proj-1', {
        action: 'delete',
        node: { id: 'n1' },
      });
      expect(busPublish).toHaveBeenCalledWith({
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.FILE_TREE_UPDATE,
        payload: { action: 'delete', node: { id: 'n1' } },
      });

      facade.broadcastCompileProgress('proj-1', { status: 'compiling' });
      expect(busPublish).toHaveBeenCalledWith({
        type: 'pages:project-event',
        projectId: 'proj-1',
        event: PAGES_EVENTS.COMPILE_PROGRESS,
        payload: { status: 'compiling' },
      });

      const projectPresence = await facade.getProjectPresence('proj-1');
      expect(projectPresence).toEqual([
        {
          userId: 'user-1',
          socketId: 'sock-1',
          spaceId: 'proj-1',
          name: 'Alice',
          color: '#EF4444',
          avatar: null,
          activeDocId: 'doc-1',
          cursor: null,
          lastHeartbeat: 12345,
        },
      ]);

      const docPresence = await facade.getDocPresence('proj-1', 'doc-1');
      expect(docPresence).toHaveLength(1);
    });
  });

  describe('5. RealtimeServiceAppModule NestJS Bootstrap & HTTP Control Plane', () => {
    let app: NestFastifyApplication;
    let derivedKey: string;

    beforeAll(async () => {
      process.env.DISABLE_REDIS = 'true';
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'test-realtime-secret';
      delete process.env.REALTIME_INTERNAL_API_KEY;
      derivedKey = resolveRealtimeInternalKey();

      const mockPrisma = {
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      };

      const moduleRef = await Test.createTestingModule({
        imports: [RealtimeServiceAppModule],
      })
        .overrideProvider(PrismaService)
        .useValue(mockPrisma)
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

    it('boots cleanly without API REST controllers and authenticates /internal/realtime/*', async () => {
      const rootRes = await app.inject({ method: 'GET', url: '/' });
      expect(rootRes.statusCode).toBe(200);
      const rootBody = JSON.parse(rootRes.body) as {
        status: string;
        service: string;
        namespaces: string[];
      };
      expect(rootBody.status).toBe('ok');
      expect(rootBody.service).toBe('flux-realtime');
      expect(rootBody.namespaces).toEqual(
        expect.arrayContaining(Object.values(REALTIME_NAMESPACES)),
      );

      const healthRes = await app.inject({
        method: 'GET',
        url: '/health/liveness',
      });
      expect(healthRes.statusCode).toBe(200);
      expect((JSON.parse(healthRes.body) as { status: string }).status).toBe(
        'ok',
      );

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
