import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRoleGuard } from '@/modules/iam/authorization/guards/workspace-role.guard';
import { ProjectRoleGuard } from '@/modules/iam/authorization/guards/project-role.guard';
import { WorkspaceRole } from '@/modules/iam/authorization/enums/workspace-role.enum';
import { ProjectRole } from '@/modules/iam/authorization/enums/project-role.enum';

describe('IAM Authorization Guards', () => {
  let reflector: Reflector;
  let prismaService: any;

  beforeEach(() => {
    reflector = new Reflector();
    prismaService = {
      workspace: {
        findFirst: jest.fn(),
      },
      workspaceMember: {
        findFirst: jest.fn(),
      },
      project: {
        findUnique: jest.fn(),
      },
      projectMember: {
        findFirst: jest.fn(),
      },
    };
  });

  const createMockContext = (
    user: any,
    params: any = {},
    headers: any = {},
    query: any = {},
    body: any = {},
  ): ExecutionContext => {
    const req = {
      user,
      params,
      headers,
      query,
      body,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;
  };

  describe('WorkspaceRoleGuard', () => {
    let guard: WorkspaceRoleGuard;

    beforeEach(() => {
      guard = new WorkspaceRoleGuard(reflector, prismaService);
    });

    it('should throw ForbiddenException if user is not authenticated', async () => {
      const context = createMockContext(null, { workspaceId: 'ws-1' });
      await expect(guard.canActivate(context)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException if user is not a workspace member', async () => {
      const context = createMockContext(
        { id: 'user-1' },
        { workspaceId: 'ws-1' },
      );
      prismaService.workspace.findFirst.mockResolvedValue({ id: 'ws-1' });
      prismaService.workspaceMember.findFirst.mockResolvedValue(null);

      await expect(guard.canActivate(context)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow access if user has required role or higher', async () => {
      const context = createMockContext(
        { id: 'user-1' },
        { workspaceId: 'ws-1' },
      );
      prismaService.workspace.findFirst.mockResolvedValue({ id: 'ws-1' });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.ADMIN,
        userId: 'user-1',
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([WorkspaceRole.MEMBER]);

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should deny access if user has lower role than required', async () => {
      const context = createMockContext(
        { id: 'user-1' },
        { workspaceId: 'ws-1' },
      );
      prismaService.workspace.findFirst.mockResolvedValue({ id: 'ws-1' });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.VIEWER,
        userId: 'user-1',
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([WorkspaceRole.ADMIN]);

      await expect(guard.canActivate(context)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('ProjectRoleGuard', () => {
    let guard: ProjectRoleGuard;

    beforeEach(() => {
      guard = new ProjectRoleGuard(reflector, prismaService);
    });

    it('should allow project contributor when contributor role required', async () => {
      const context = createMockContext({ id: 'user-1' }, { projectId: 'p-1' });
      prismaService.project.findUnique.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-1',
        members: [{ role: ProjectRole.CONTRIBUTOR, joinedAt: new Date() }],
      });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.MEMBER,
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([ProjectRole.CONTRIBUTOR]);

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow workspace admin even if not in project member list (escalation rule)', async () => {
      const context = createMockContext(
        { id: 'user-admin' },
        { projectId: 'p-1' },
      );
      prismaService.project.findUnique.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-1',
        members: [],
      });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.ADMIN,
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([ProjectRole.ADMIN]);

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should deny project viewer from performing admin actions', async () => {
      const context = createMockContext(
        { id: 'user-viewer' },
        { projectId: 'p-1' },
      );
      prismaService.project.findUnique.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-1',
        members: [{ role: ProjectRole.VIEWER, joinedAt: new Date() }],
      });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.MEMBER,
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([ProjectRole.ADMIN]);

      await expect(guard.canActivate(context)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should resolve projectId from cycleId param and authorize', async () => {
      const context = createMockContext(
        { id: 'user-contrib' },
        { cycleId: 'cycle-1' },
      );
      prismaService.cycle = {
        findUnique: jest.fn().mockResolvedValue({ projectId: 'p-1' }),
      } as any;
      prismaService.project.findUnique.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-1',
        members: [{ role: ProjectRole.CONTRIBUTOR, joinedAt: new Date() }],
      });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.MEMBER,
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([ProjectRole.CONTRIBUTOR]);

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(prismaService.cycle.findUnique).toHaveBeenCalledWith({
        where: { id: 'cycle-1' },
        select: { projectId: true },
      });
    });

    it('should resolve projectId from taskId param and authorize', async () => {
      const context = createMockContext(
        { id: 'user-contrib' },
        { taskId: 'task-1' },
      );
      prismaService.task = {
        findUnique: jest.fn().mockResolvedValue({ projectId: 'p-1' }),
      } as any;
      prismaService.project.findUnique.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-1',
        members: [{ role: ProjectRole.CONTRIBUTOR, joinedAt: new Date() }],
      });
      prismaService.workspaceMember.findFirst.mockResolvedValue({
        role: WorkspaceRole.MEMBER,
      });

      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([ProjectRole.CONTRIBUTOR]);

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(prismaService.task.findUnique).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        select: { projectId: true },
      });
    });
  });
});
