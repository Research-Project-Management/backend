import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WorkspaceRoleGuard } from '@/core/guards/workspace-role.guard';
import { PrismaService } from '@/core/database/prisma.service';

describe('WorkspaceRoleGuard', () => {
  let guard: WorkspaceRoleGuard;
  let reflector: Reflector;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceRoleGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            workspaceMember: {
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    guard = module.get<WorkspaceRoleGuard>(WorkspaceRoleGuard);
    reflector = module.get<Reflector>(Reflector);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should throw ForbiddenException if user is not attached', async () => {
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should allow if user is owner and admin role required', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);
    (prisma.workspaceMember.findFirst as jest.Mock).mockResolvedValue({
      workspaceId: 'ws-1',
      userId: 'user-1',
      role: 'owner',
    });

    const request = {
      user: { sub: 'user-1' },
      params: { workspaceId: 'ws-1' },
    };
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });
});
