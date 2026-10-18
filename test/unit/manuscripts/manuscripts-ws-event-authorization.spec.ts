import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { Socket } from 'socket.io';
import { MESSAGE_MAPPING_METADATA, MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { ManuscriptsGateway } from '@/modules/realtime/manuscripts/manuscripts.gateway';
import { WS_ACCESS_LEVEL_KEY, WsAccessLevel } from '@/modules/realtime/core/ws-access.decorator';
import { WsAccessGuard } from '@/modules/realtime/core/ws-access.guard';
import { RealtimeAccessService } from '@/modules/realtime/manuscripts/realtime-access.service';
import { REALTIME_EVENTS } from '@/modules/realtime/core/realtime.constant';
import { Role, Permission, AccessService, MemberAccessContext } from '@/modules/project/access';
import { PrismaService } from '@/core';
import { RealtimeConfigService } from '@/modules/realtime/core/realtime.config';
import {
  RealtimeAccessDeniedException,
  RealtimeAuthRequiredException,
  RealtimeRoleInsufficientException,
  RealtimeServiceUnavailableException,
} from '@/modules/realtime/core/ws-errors';

describe('Realtime Event Authorization & WsAccessGuard (US2 & US3 & Contract Verification)', () => {
  const EXPECTED_CONTRACT_LEVELS: Record<string, WsAccessLevel> = {
    [REALTIME_EVENTS.PROJECT_JOIN]: 'member',
    [REALTIME_EVENTS.PROJECT_LEAVE]: 'none',
    [REALTIME_EVENTS.DOC_JOIN]: 'read',
    [REALTIME_EVENTS.DOC_LEAVE]: 'none',
    [REALTIME_EVENTS.DOC_UPDATE]: 'write',
    [REALTIME_EVENTS.DOC_CURSOR]: 'read',
    [REALTIME_EVENTS.YJS_SYNC_STEP_1]: 'read',
    [REALTIME_EVENTS.YJS_SYNC_STEP_2]: 'write',
    [REALTIME_EVENTS.YJS_SYNC_UPDATE]: 'write',
    [REALTIME_EVENTS.CHAT_SEND]: 'member',
    [REALTIME_EVENTS.CHAT_HISTORY]: 'member',
  };

  const projectIdA = '00000000-0000-0000-0000-000000000001';
  const projectIdB = '00000000-0000-0000-0000-000000000002';
  const docIdA = '00000000-0000-0000-0000-000000000010';
  const docIdB = '00000000-0000-0000-0000-000000000020';

  const userOwner = '00000000-0000-0000-0000-000000000100';
  const userContributor = '00000000-0000-0000-0000-000000000200';
  const userReviewer = '00000000-0000-0000-0000-000000000300';
  const userNonMember = '00000000-0000-0000-0000-000000000400';

  let mockAccessService: jest.Mocked<AccessService>;
  let mockPrisma: jest.Mocked<PrismaService>;
  let mockConfig: jest.Mocked<RealtimeConfigService>;
  let realtimeAccess: RealtimeAccessService;
  let guard: WsAccessGuard;
  let reflector: Reflector;

  beforeEach(() => {
    mockAccessService = {
      getMemberAccessContext: jest.fn(),
    } as unknown as jest.Mocked<AccessService>;

    mockPrisma = {
      manuscriptDoc: {
        findUnique: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;

    mockConfig = {
      getAuthCacheTtlSeconds: jest.fn().mockReturnValue(30),
      getJwtSecret: jest.fn().mockReturnValue('test-secret'),
    } as unknown as jest.Mocked<RealtimeConfigService>;

    realtimeAccess = new RealtimeAccessService(
      mockAccessService,
      mockPrisma,
      mockConfig,
    );

    reflector = new Reflector();
    guard = new WsAccessGuard(reflector, realtimeAccess);
  });

  describe('1. Reflection Contract Compliance', () => {
    it('verifies every @SubscribeMessage handler has explicit @WsAccess metadata matching the contract', () => {
      const prototype = ManuscriptsGateway.prototype as Record<string, any>;
      const methodNames = Object.getOwnPropertyNames(prototype).filter(
        (prop) => typeof prototype[prop] === 'function' && prop !== 'constructor',
      );

      for (const name of methodNames) {
        const fn = prototype[name];
        const isMessageMapping = Reflect.getMetadata(MESSAGE_MAPPING_METADATA, fn);
        if (isMessageMapping) {
          const message = Reflect.getMetadata(MESSAGE_METADATA, fn);
          const declaredLevel: WsAccessLevel | undefined = Reflect.getMetadata(
            WS_ACCESS_LEVEL_KEY,
            fn,
          );

          expect(declaredLevel).toBeDefined();
          expect(declaredLevel).toBe(EXPECTED_CONTRACT_LEVELS[message]);
        }
      }
    });
  });

  describe('2. RealtimeAccessService Access Decisions & Caching', () => {
    it('returns allowed for contributor with edit permissions', async () => {
      const contributorContext: MemberAccessContext = {
        userId: userContributor,
        projectId: projectIdA,
        role: Role.CONTRIBUTOR,
        permissionOverrides: {},
        effectivePermissions: [
          Permission.DOCUMENT_READ,
          Permission.DOCUMENT_VIEW,
          Permission.DOCUMENT_UPDATE,
          Permission.DOCUMENT_EDIT,
        ],
      };
      mockAccessService.getMemberAccessContext.mockResolvedValue(contributorContext);

      const canRead = await realtimeAccess.checkAccess(projectIdA, userContributor, 'read');
      const canWrite = await realtimeAccess.checkAccess(projectIdA, userContributor, 'write');
      const isMember = await realtimeAccess.checkAccess(projectIdA, userContributor, 'member');

      expect(canRead).toBe('allowed');
      expect(canWrite).toBe('allowed');
      expect(isMember).toBe('allowed');
    });

    it('enforces read-only for reviewer: can read and chat, but write is denied (US3 / RT-03)', async () => {
      const reviewerContext: MemberAccessContext = {
        userId: userReviewer,
        projectId: projectIdA,
        role: Role.REVIEWER,
        permissionOverrides: {},
        effectivePermissions: [
          Permission.DOCUMENT_READ,
          Permission.DOCUMENT_VIEW,
          Permission.COMMENT_CREATE,
        ],
      };
      mockAccessService.getMemberAccessContext.mockResolvedValue(reviewerContext);

      const canRead = await realtimeAccess.checkAccess(projectIdA, userReviewer, 'read');
      const canWrite = await realtimeAccess.checkAccess(projectIdA, userReviewer, 'write');
      const isMember = await realtimeAccess.checkAccess(projectIdA, userReviewer, 'member');

      expect(canRead).toBe('allowed');
      expect(canWrite).toBe('denied');
      expect(isMember).toBe('allowed');
    });

    it('denies access for non-members (SC-002)', async () => {
      mockAccessService.getMemberAccessContext.mockResolvedValue(null);

      const decision = await realtimeAccess.checkAccess(projectIdA, userNonMember, 'read');
      expect(decision).toBe('denied');
    });

    it('fails closed and reports unavailable on database outages (RT-05 / RT-43 / SC-009)', async () => {
      mockAccessService.getMemberAccessContext.mockRejectedValue(
        new Error('Database connection pool exhausted'),
      );

      const decision = await realtimeAccess.checkAccess(projectIdA, userContributor, 'write');
      expect(decision).toBe('unavailable');
    });

    it('validates document belongs to project (RT-04)', async () => {
      (mockPrisma.manuscriptDoc.findUnique as jest.Mock).mockResolvedValue({
        projectId: projectIdA,
      });

      const valid = await realtimeAccess.validateDocInProject(projectIdA, docIdA);
      expect(valid).toBe(true);

      const invalid = await realtimeAccess.validateDocInProject(projectIdB, docIdA);
      expect(invalid).toBe(false);
    });

    it('evicts cached access decisions on demand', async () => {
      const contributorContext: MemberAccessContext = {
        userId: userContributor,
        projectId: projectIdA,
        role: Role.CONTRIBUTOR,
        permissionOverrides: {},
        effectivePermissions: [Permission.DOCUMENT_READ, Permission.DOCUMENT_UPDATE],
      };
      mockAccessService.getMemberAccessContext.mockResolvedValue(contributorContext);

      await realtimeAccess.getProjectAccess(projectIdA, userContributor);
      expect(mockAccessService.getMemberAccessContext).toHaveBeenCalledTimes(1);

      // Hit cache
      await realtimeAccess.getProjectAccess(projectIdA, userContributor);
      expect(mockAccessService.getMemberAccessContext).toHaveBeenCalledTimes(1);

      // Evict and verify next call queries service
      realtimeAccess.evictCache(projectIdA, userContributor);
      await realtimeAccess.getProjectAccess(projectIdA, userContributor);
      expect(mockAccessService.getMemberAccessContext).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. WsAccessGuard Execution Flow', () => {
    const createMockExecutionContext = (options: {
      handler: Function;
      socketData: Record<string, any>;
      payload?: Record<string, any>;
    }): ExecutionContext => {
      const mockSocket = {
        id: 'sock-test-1',
        data: options.socketData,
      } as unknown as Socket;

      return {
        switchToWs: () => ({
          getClient: () => mockSocket,
          getData: () => options.payload || {},
        }),
        getHandler: () => options.handler,
        getClass: () => ManuscriptsGateway,
      } as unknown as ExecutionContext;
    };

    it('rejects unauthenticated socket attempting to invoke guarded handler', async () => {
      const handler = ManuscriptsGateway.prototype.handleJoinProject;
      const context = createMockExecutionContext({
        handler,
        socketData: { authenticated: false },
        payload: { projectId: projectIdA },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        RealtimeAuthRequiredException,
      );
    });

    it('allows project:join for valid member', async () => {
      const handler = ManuscriptsGateway.prototype.handleJoinProject;
      mockAccessService.getMemberAccessContext.mockResolvedValue({
        userId: userContributor,
        projectId: projectIdA,
        role: Role.CONTRIBUTOR,
        permissionOverrides: {},
        effectivePermissions: [Permission.DOCUMENT_READ],
      });

      const context = createMockExecutionContext({
        handler,
        socketData: { authenticated: true, userId: userContributor },
        payload: { projectId: projectIdA },
      });

      const allowed = await guard.canActivate(context);
      expect(allowed).toBe(true);
    });

    it('rejects doc:join when socket has not joined the project first (US2)', async () => {
      const handler = ManuscriptsGateway.prototype.handleJoinDoc;
      const context = createMockExecutionContext({
        handler,
        socketData: {
          authenticated: true,
          userId: userContributor,
          projectId: projectIdB, // joined project B
        },
        payload: { projectId: projectIdA, docId: docIdA }, // trying to join doc in project A
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        RealtimeAccessDeniedException,
      );
    });

    it('rejects doc:join when doc belongs to a foreign project (IDOR prevention)', async () => {
      const handler = ManuscriptsGateway.prototype.handleJoinDoc;
      (mockPrisma.manuscriptDoc.findUnique as jest.Mock).mockResolvedValue({
        projectId: projectIdB, // Doc actually belongs to B
      });

      const context = createMockExecutionContext({
        handler,
        socketData: {
          authenticated: true,
          userId: userContributor,
          projectId: projectIdA, // Socket joined A
        },
        payload: { projectId: projectIdA, docId: docIdB }, // Doc belonging to B
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        RealtimeAccessDeniedException,
      );
    });

    it('strictly rejects write operations from reviewer role (US3)', async () => {
      const handler = ManuscriptsGateway.prototype.handleDocUpdate;
      mockAccessService.getMemberAccessContext.mockResolvedValue({
        userId: userReviewer,
        projectId: projectIdA,
        role: Role.REVIEWER,
        permissionOverrides: {},
        effectivePermissions: [Permission.DOCUMENT_READ, Permission.DOCUMENT_VIEW],
      });

      const context = createMockExecutionContext({
        handler,
        socketData: {
          authenticated: true,
          userId: userReviewer,
          projectId: projectIdA,
          activeDocId: docIdA,
        },
        payload: { projectId: projectIdA, docId: docIdA, clientRev: 1 },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        RealtimeRoleInsufficientException,
      );
    });

    it('allows read operations (cursor, sync step 1) for reviewer role', async () => {
      const handler = ManuscriptsGateway.prototype.handleCursorUpdate;
      mockAccessService.getMemberAccessContext.mockResolvedValue({
        userId: userReviewer,
        projectId: projectIdA,
        role: Role.REVIEWER,
        permissionOverrides: {},
        effectivePermissions: [Permission.DOCUMENT_READ, Permission.DOCUMENT_VIEW],
      });

      const context = createMockExecutionContext({
        handler,
        socketData: {
          authenticated: true,
          userId: userReviewer,
          projectId: projectIdA,
          activeDocId: docIdA,
        },
        payload: { projectId: projectIdA, docId: docIdA },
      });

      const allowed = await guard.canActivate(context);
      expect(allowed).toBe(true);
    });

    it('throws RealtimeServiceUnavailableException when authorization dependency is down (fail closed)', async () => {
      const handler = ManuscriptsGateway.prototype.handleDocUpdate;
      mockAccessService.getMemberAccessContext.mockRejectedValue(
        new Error('DB unreachable'),
      );

      const context = createMockExecutionContext({
        handler,
        socketData: {
          authenticated: true,
          userId: userContributor,
          projectId: projectIdA,
          activeDocId: docIdA,
        },
        payload: { projectId: projectIdA, docId: docIdA },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        RealtimeServiceUnavailableException,
      );
    });
  });
});
