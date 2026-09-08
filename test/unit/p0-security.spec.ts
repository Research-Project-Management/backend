import {
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { AiService } from '@/modules/ai/ai.service';
import { EngineService } from '@/modules/ai/engine/engine.service';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { PrismaService } from '@/core/database/prisma.service';

describe('P0 Security Regression Tests', () => {
  const TEST_JWT_SECRET = 'test-jwt-secret-key-32-chars-minimum!!';
  const TEST_INTERNAL_KEY = 'super-secret-internal-key-12345';

  let jwtService: JwtService;
  let configService: ConfigService;
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = new JwtService();
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'JWT_SECRET') return TEST_JWT_SECRET;
        if (key === 'INTERNAL_API_KEY') return TEST_INTERNAL_KEY;
        return null;
      }),
    } as unknown as ConfigService;
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    guard = new JwtAuthGuard(jwtService, configService, reflector);
  });

  function createMockContext(
    headers: Record<string, string>,
    isPublic = false,
  ): ExecutionContext {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(isPublic);
    const req: any = { headers, user: null };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
  }

  describe('JwtAuthGuard — Trust Boundary & Spoofing Prevention', () => {
    it('allows @Public() routes to bypass authentication', async () => {
      const ctx = createMockContext({}, true);
      const allowed = await guard.canActivate(ctx);
      expect(allowed).toBe(true);
    });

    it('rejects requests with missing Authorization header and no internal key', async () => {
      const ctx = createMockContext({});
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects internal service request with invalid X-Internal-Key', async () => {
      const ctx = createMockContext({
        'x-internal-key': 'wrong-internal-key-value',
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Invalid internal service credentials',
      );
    });

    it('rejects internal service request with valid X-Internal-Key but missing delegation token', async () => {
      const ctx = createMockContext({
        'x-internal-key': TEST_INTERNAL_KEY,
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Internal service calls require a signed delegation token',
      );
    });

    it('rejects internal service request when x-user-id header does not match delegation token subject (anti-spoofing)', async () => {
      const delegationToken = await jwtService.signAsync(
        { sub: 'legitimate-user-id', workspace_id: 'ws-1' },
        { secret: TEST_JWT_SECRET, expiresIn: '5m' },
      );

      const ctx = createMockContext({
        'x-internal-key': TEST_INTERNAL_KEY,
        authorization: `Bearer ${delegationToken}`,
        'x-user-id': 'attacker-spoofed-user-id',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Spoofed user ID does not match delegation token subject',
      );
    });

    it('accepts internal service request with valid key and matching delegation token', async () => {
      const delegationToken = await jwtService.signAsync(
        { sub: 'legitimate-user-id', workspace_id: 'ws-1' },
        { secret: TEST_JWT_SECRET, expiresIn: '5m' },
      );

      const ctx = createMockContext({
        'x-internal-key': TEST_INTERNAL_KEY,
        authorization: `Bearer ${delegationToken}`,
      });

      const req = ctx.switchToHttp().getRequest();
      const allowed = await guard.canActivate(ctx);

      expect(allowed).toBe(true);
      expect(req.user.id).toBe('legitimate-user-id');
      expect(req.user.sub).toBe('legitimate-user-id');
      expect(req.user.isInternalService).toBe(true);
    });

    it('accepts standard user Bearer token', async () => {
      const userToken = await jwtService.signAsync(
        { sub: 'user-normal-42', email: 'user@flux.io' },
        { secret: TEST_JWT_SECRET, expiresIn: '1h' },
      );

      const ctx = createMockContext({
        authorization: `Bearer ${userToken}`,
      });

      const req = ctx.switchToHttp().getRequest();
      const allowed = await guard.canActivate(ctx);

      expect(allowed).toBe(true);
      expect(req.user.sub).toBe('user-normal-42');
    });
  });

  describe('AiService — Multi-Tenant Access Control', () => {
    let aiService: AiService;
    let mockPrisma: any;
    let mockEngine: any;
    let mockThread: any;

    beforeEach(() => {
      mockPrisma = {
        workspaceMember: {
          findFirst: jest.fn(),
        },
        project: {
          findFirst: jest.fn(),
        },
        aiChat: {
          findFirst: jest.fn(),
        },
      };
      mockEngine = {
        streamChat: jest.fn().mockResolvedValue(undefined),
        syncChat: jest
          .fn()
          .mockResolvedValue({ role: 'assistant', content: 'hello' }),
        uploadDocument: jest.fn().mockResolvedValue({ id: 'doc-123' }),
        getDocumentsBulk: jest.fn().mockResolvedValue([]),
        getDocument: jest.fn().mockResolvedValue(null),
        getDocuments: jest.fn().mockResolvedValue([]),
      };
      mockThread = {
        appendMessages: jest.fn().mockResolvedValue(undefined),
      };

      aiService = new AiService(
        mockEngine as EngineService,
        mockThread as ThreadService,
        mockPrisma as PrismaService,
      );
    });

    it('rejects access if user is not a member of the requested workspace', async () => {
      mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);

      await expect(
        aiService.stream(
          'user-1',
          { message: 'hi', workspaceId: 'ws-unauthorized' } as any,
          {} as any,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockEngine.streamChat).not.toHaveBeenCalled();
    });

    it('rejects access if requested project does not belong to user', async () => {
      mockPrisma.workspaceMember.findFirst.mockResolvedValue({
        id: 'member-1',
      });
      mockPrisma.project.findFirst.mockResolvedValue(null);

      await expect(
        aiService.stream(
          'user-1',
          {
            message: 'hi',
            workspaceId: 'ws-1',
            projectId: 'proj-unauthorized',
          } as any,
          {} as any,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockEngine.streamChat).not.toHaveBeenCalled();
    });

    it('rejects access if requested project does not belong to specified workspace', async () => {
      mockPrisma.workspaceMember.findFirst.mockResolvedValue({
        id: 'member-1',
      });
      mockPrisma.project.findFirst.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-other',
      });

      await expect(
        aiService.stream(
          'user-1',
          { message: 'hi', workspaceId: 'ws-1', projectId: 'proj-1' } as any,
          {} as any,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mockEngine.streamChat).not.toHaveBeenCalled();
    });

    it('rejects access if user tries to hijack another user chat session', async () => {
      mockPrisma.workspaceMember.findFirst.mockResolvedValue({
        id: 'member-1',
      });
      mockPrisma.aiChat.findFirst.mockResolvedValue({
        id: 'chat-victim',
        userId: 'victim-user-id',
      });

      await expect(
        aiService.stream(
          'attacker-user-id',
          { message: 'hi', workspaceId: 'ws-1', chatId: 'chat-victim' } as any,
          {} as any,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockEngine.streamChat).not.toHaveBeenCalled();
    });

    it('allows access and calls engine when user has valid membership', async () => {
      mockPrisma.workspaceMember.findFirst.mockResolvedValue({
        id: 'member-1',
      });
      mockPrisma.project.findFirst.mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.aiChat.findFirst.mockResolvedValue({
        id: 'chat-1',
        userId: 'user-1',
      });

      await aiService.stream(
        'user-1',
        {
          message: 'hello',
          workspaceId: 'ws-1',
          projectId: 'proj-1',
          chatId: 'chat-1',
        },
        {
          hijack: jest.fn(),
          raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() },
        } as any,
      );

      expect(mockEngine.streamChat).toHaveBeenCalledTimes(1);
    });
  });
});
