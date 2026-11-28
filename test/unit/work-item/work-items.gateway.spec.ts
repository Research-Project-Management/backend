import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Server, Socket } from 'socket.io';
import { Role } from '@/modules/project/access';
import { WorkItemsEventsBridge } from '@/modules/realtime/adapters/work-items';
import {
  WORK_ITEMS_EVENTS,
  WORK_ITEMS_ROOMS,
  WorkItemsRealtimeConfigService,
} from '@/modules/realtime/channels/work-items/config';
import { WorkItemsGateway } from '@/modules/realtime/channels/work-items/gateway';
import { WorkItemsWsGuard } from '@/modules/realtime/channels/work-items/guard';
import type { WorkItemsAccessPort } from '@/modules/realtime/ports/work-items';
import { RealtimeEventBus } from '@/modules/realtime/core/bus';
import {
  RealtimeAccessDeniedException,
  RealtimeAuthRequiredException,
  RealtimeRateLimitedException,
  RealtimeValidationFailedException,
  WsAllExceptionsFilter,
  WsRateLimiter,
  type WsAuthService,
} from '@/modules/realtime';

describe('WorkItemsGateway, Bridge & WorkItemsWsGuard Unit Tests', () => {
  let gateway: WorkItemsGateway;
  let bridge: WorkItemsEventsBridge;
  let guard: WorkItemsWsGuard;
  let mockAuthService: jest.Mocked<WsAuthService>;
  let mockAccessPort: {
    getRole: jest.Mock;
    invalidateAccessCache: jest.Mock;
  };
  let rateLimiter: WsRateLimiter;
  let workItemsConfig: WorkItemsRealtimeConfigService;
  let realtimeBus: RealtimeEventBus;
  let serverEmit: jest.Mock;
  let roomEmitMap: Map<string, jest.Mock>;
  let serverTo: jest.Mock;
  let mockServer: Server;

  const makeSocket = (overrides?: {
    id?: string;
    authenticated?: boolean;
    userId?: string;
  }) => {
    const rooms = new Set<string>();
    const join = jest.fn(async (room: string) => {
      rooms.add(room);
    });
    const leave = jest.fn(async (room: string) => {
      rooms.delete(room);
    });

    const socket = fromPartial<Socket>({
      id: overrides?.id ?? 'sock-wi-1',
      data:
        overrides?.authenticated === false
          ? { authenticated: false }
          : {
              authenticated: overrides?.authenticated ?? true,
              userId: overrides?.userId ?? 'user-1',
            },
      rooms,
      join,
      leave,
      disconnect: jest.fn(),
    });

    return { socket, join, leave, rooms };
  };

  beforeEach(() => {
    mockAuthService = fromPartial<jest.Mocked<WsAuthService>>({
      authenticateSocket: jest.fn(),
    });
    mockAccessPort = {
      getRole: jest.fn().mockResolvedValue(Role.CONTRIBUTOR),
      invalidateAccessCache: jest.fn().mockResolvedValue(undefined),
    };
    rateLimiter = new WsRateLimiter();
    workItemsConfig = new WorkItemsRealtimeConfigService();
    realtimeBus = new RealtimeEventBus();

    const accessPort = fromPartial<WorkItemsAccessPort>(mockAccessPort);
    guard = new WorkItemsWsGuard(accessPort);
    bridge = new WorkItemsEventsBridge(realtimeBus);
    gateway = new WorkItemsGateway(
      mockAuthService,
      rateLimiter,
      workItemsConfig,
      accessPort,
      realtimeBus,
    );

    serverEmit = jest.fn();
    roomEmitMap = new Map<string, jest.Mock>();
    serverTo = jest.fn((target: string | string[]) => {
      const key = Array.isArray(target) ? target.join(',') : target;
      let fn = roomEmitMap.get(key);
      if (!fn) {
        fn = jest.fn();
        roomEmitMap.set(key, fn);
      }
      return { emit: fn };
    });

    mockServer = fromPartial<Server>({
      use: jest.fn(),
      emit: serverEmit,
      local: fromPartial<Server>({
        to: serverTo as never,
      }) as never,
      to: serverTo as never,
    });
    gateway.server = mockServer;
    gateway.onModuleInit();
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  describe('WorkItemsWsGuard', () => {
    const makeCtx = (
      socketData: Record<string, unknown>,
      data: Record<string, unknown>,
    ): ExecutionContext =>
      fromPartial<ExecutionContext>({
        switchToWs: () => ({
          getClient: () =>
            fromPartial<Socket>({ id: 's-guard', data: socketData }),
          getData: () => data,
        }),
      });

    it('rejects unauthenticated sockets, blank projectIds, and non-members while admitting project members/reviewers', async () => {
      await expect(
        guard.canActivate(
          makeCtx({ authenticated: false }, { projectId: 'proj-1' }),
        ),
      ).rejects.toThrow(RealtimeAuthRequiredException);

      await expect(
        guard.canActivate(
          makeCtx({ authenticated: true, userId: '' }, { projectId: 'proj-1' }),
        ),
      ).rejects.toThrow(RealtimeAuthRequiredException);

      await expect(
        guard.canActivate(
          makeCtx({ authenticated: true, userId: 'u-1' }, { projectId: '   ' }),
        ),
      ).rejects.toThrow(RealtimeValidationFailedException);

      mockAccessPort.getRole.mockResolvedValueOnce(null);
      await expect(
        guard.canActivate(
          makeCtx(
            { authenticated: true, userId: 'outsider' },
            { projectId: 'proj-1' },
          ),
        ),
      ).rejects.toThrow(RealtimeAccessDeniedException);

      mockAccessPort.getRole.mockResolvedValueOnce(Role.REVIEWER);
      await expect(
        guard.canActivate(
          makeCtx(
            { authenticated: true, userId: 'reviewer-1' },
            { projectId: 'proj-1' },
          ),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('WorkItemsEventsBridge -> RealtimeEventBus -> WorkItemsGateway', () => {
    it('attaches exception filter & validation pipe, enforces socket auth, joins/leaves rooms, and enforces rate limits', async () => {
      const filters = Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        WorkItemsGateway,
      ) as unknown[];
      const pipes = Reflect.getMetadata(
        PIPES_METADATA,
        WorkItemsGateway,
      ) as unknown[];
      expect(filters).toContain(WsAllExceptionsFilter);
      expect(Array.isArray(pipes) && pipes.length > 0).toBe(true);

      gateway.afterInit(mockServer);
      expect(mockServer.use).toHaveBeenCalledWith(expect.any(Function));

      const unauth = makeSocket({ authenticated: false });
      mockAuthService.authenticateSocket.mockRejectedValueOnce(
        new RealtimeAuthRequiredException(),
      );
      await gateway.handleConnection(unauth.socket);
      expect(unauth.socket.disconnect).toHaveBeenCalledWith(true);

      const { socket, join, leave } = makeSocket({ userId: 'user-1' });
      await expect(
        gateway.handleJoinProject(socket, { projectId: 'proj-1' }),
      ).resolves.toEqual({ success: true, projectId: 'proj-1' });
      expect(join).toHaveBeenCalledWith(WORK_ITEMS_ROOMS.project('proj-1'));

      await expect(
        gateway.handleLeaveProject(socket, { projectId: 'proj-1' }),
      ).resolves.toEqual({ success: true, projectId: 'proj-1' });
      expect(leave).toHaveBeenCalledWith(WORK_ITEMS_ROOMS.project('proj-1'));

      const { socket: burstSocket } = makeSocket({
        id: 'sock-burst',
        userId: 'user-2',
      });
      const burst = workItemsConfig.getRateLimitBudgets().joinLeave.burst;
      for (let i = 0; i < burst; i += 1) {
        await gateway.handleLeaveProject(burstSocket, { projectId: 'proj-1' });
      }
      await expect(
        gateway.handleLeaveProject(burstSocket, { projectId: 'proj-1' }),
      ).rejects.toThrow(RealtimeRateLimitedException);
    });

    it('delivers work-item/state domain events strictly to project:<projectId> and evicts revoked member sockets', async () => {
      const p1 = { projectId: 'proj-9', entityId: 'wi-1', verb: 'created' };
      const p2 = { projectId: 'proj-9', entityId: 'wi-1', verb: 'transitioned' };
      const p3 = { projectId: 'proj-9', entityId: 'wi-1', verb: 'updated' };
      const p4 = { projectId: 'proj-9', entityId: 'wi-1', verb: 'deleted' };
      const p5 = { projectId: 'proj-9', entityId: 'proj-9', verb: 'updated' };

      await bridge.handleWorkItemCreated(p1);
      await bridge.handleWorkItemDuplicated(p1);
      await bridge.handleWorkItemStateChanged(p2);
      await bridge.handleWorkItemUpdated(p3);
      await bridge.handleWorkItemArchived(p3);
      await bridge.handleWorkItemRestored(p3);
      await bridge.handleWorkItemBulkArchived(p3);
      await bridge.handleWorkItemBulkRestored(p3);
      await bridge.handleWorkItemDeleted(p4);
      await bridge.handleStateUpdated(p5);
      await bridge.handleWorkItemUpdated({});

      const emitFn = roomEmitMap.get(WORK_ITEMS_ROOMS.project('proj-9'));
      expect(emitFn).toHaveBeenCalledWith(WORK_ITEMS_EVENTS.CREATED, p1);
      expect(emitFn).toHaveBeenCalledWith(WORK_ITEMS_EVENTS.STATE_CHANGED, p2);
      expect(emitFn).toHaveBeenCalledWith(WORK_ITEMS_EVENTS.UPDATED, p3);
      expect(emitFn).toHaveBeenCalledWith(WORK_ITEMS_EVENTS.DELETED, p4);
      expect(emitFn).toHaveBeenCalledWith(WORK_ITEMS_EVENTS.STATE_UPDATED, p5);
      expect(emitFn).toHaveBeenCalledTimes(10);
      expect(serverEmit).not.toHaveBeenCalled();

      const targetLeave = jest.fn();
      const targetEmit = jest.fn();
      const otherLeave = jest.fn();
      const otherEmit = jest.fn();
      const fetchSockets = jest.fn().mockResolvedValue([
        {
          id: 's-target',
          data: { userId: 'u-removed' },
          emit: targetEmit,
          leave: targetLeave,
        },
        {
          id: 's-other',
          data: { userId: 'u-stay' },
          emit: otherEmit,
          leave: otherLeave,
        },
      ]);
      const localIn = jest.fn(() => ({ fetchSockets }));
      gateway.server = fromPartial<Server>({
        local: fromPartial<Server>({ in: localIn as never }) as never,
      });

      await bridge.handleMemberRemoved({
        projectId: 'proj-1',
        userId: 'u-removed',
      });

      expect(mockAccessPort.invalidateAccessCache).toHaveBeenCalledWith(
        'proj-1',
        'u-removed',
      );
      expect(targetEmit).toHaveBeenCalledWith(
        WORK_ITEMS_EVENTS.ACCESS_REVOKED,
        { projectId: 'proj-1' },
      );
      expect(targetLeave).toHaveBeenCalledWith(
        WORK_ITEMS_ROOMS.project('proj-1'),
      );
      expect(otherEmit).not.toHaveBeenCalled();
      expect(otherLeave).not.toHaveBeenCalled();
    });
  });
});
