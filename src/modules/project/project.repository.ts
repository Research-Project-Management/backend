import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import {
  Prisma,
  Project,
  ProjectMember,
  ProjectMemberRole,
} from '@prisma/client';
import {
  IProjectRepository,
  ProjectWithMembers,
  USER_SELECT,
} from './types/project-repository.interface';

@Injectable()
export class ProjectRepository implements IProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(
    workspaceIdOrSlug: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdOrSlug),
      select: { id: true },
    });
  }

  async findWorkspaceProjects(
    workspaceId: string,
  ): Promise<ProjectWithMembers[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId) return [];

    return this.prisma.project.findMany({
      where: {
        workspaceId: canonicalWorkspaceId,
        isActive: true,
        deletedAt: null,
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        lead: { select: USER_SELECT },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findProjectById(projectId: string): Promise<ProjectWithMembers | null> {
    if (!isUuid(projectId)) {
      return this.prisma.project.findFirst({
        where: {
          identifier: { equals: projectId, mode: 'insensitive' },
          deletedAt: null,
        },
        include: {
          members: {
            include: {
              user: { select: USER_SELECT },
            },
          },
          lead: { select: USER_SELECT },
          workspace: {
            select: { id: true, name: true, url: true },
          },
        },
      });
    }

    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        lead: { select: USER_SELECT },
        workspace: {
          select: { id: true, name: true, url: true },
        },
      },
    });
  }

  async findProjectByIdentifier(
    workspaceId: string,
    identifier: string,
  ): Promise<ProjectWithMembers | null> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId) return null;

    return this.prisma.project.findFirst({
      where: { workspaceId: canonicalWorkspaceId, identifier, deletedAt: null },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        lead: { select: USER_SELECT },
        workspace: {
          select: { id: true, name: true, url: true },
        },
      },
    });
  }

  async createProject(
    data: Prisma.ProjectCreateInput | Prisma.ProjectUncheckedCreateInput,
  ): Promise<ProjectWithMembers> {
    return this.prisma.project.create({
      data: data as Prisma.ProjectCreateInput,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        lead: { select: USER_SELECT },
      },
    });
  }

  async updateProject(
    projectId: string,
    data: Prisma.ProjectUpdateInput | Prisma.ProjectUncheckedUpdateInput,
  ): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: data,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        lead: { select: USER_SELECT },
      },
    });
  }

  async softDeleteProject(projectId: string): Promise<Project> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async restoreProject(projectId: string): Promise<Project> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: null, isActive: true },
    });
  }

  async deleteProject(projectId: string): Promise<Project> {
    return this.prisma.project.delete({ where: { id: projectId } });
  }

  async deleteColumnWithTaskMigration(
    projectId: string,
    columnId: string,
    fallbackColumnId: string,
    updatedColumns: Prisma.InputJsonValue,
  ): Promise<Project> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Reassign all active tasks in this column to fallback column
      await tx.task.updateMany({
        where: {
          projectId,
          columnId,
          deletedAt: null,
        },
        data: {
          columnId: fallbackColumnId,
          completed: fallbackColumnId === 'done',
        },
      });

      // 2. Persist new taskColumns array on Project
      return tx.project.update({
        where: { id: projectId },
        data: { taskColumns: updatedColumns },
      });
    });
  }

  async findProjectOverview(
    projectId: string,
  ): Promise<Record<string, unknown> | null> {
    const project = await this.findProjectById(projectId);
    if (!project) return null;

    const [files, taskTotal, completedTasks, inProgressTasks] =
      await Promise.all([
        this.prisma.file.findMany({
          where: { workspaceId: project.workspaceId, trashedAt: null },
          select: { id: true, filename: true, size: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 10,
        }),
        this.prisma.task.count({
          where: { projectId, deletedAt: null },
        }),
        this.prisma.task.count({
          where: { projectId, completed: true, deletedAt: null },
        }),
        this.prisma.task.count({
          where: {
            projectId,
            completed: false,
            columnId: { in: ['doing', 'in_progress'] },
            deletedAt: null,
          },
        }),
      ]);

    const fileCount = files.length;
    const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
    const pendingTasks = Math.max(
      0,
      taskTotal - completedTasks - inProgressTasks,
    );

    return {
      project,
      stats: {
        files: {
          count: fileCount,
          totalSize,
          recent: files.slice(0, 5),
        },
        tasks: {
          total: taskTotal,
          completed: completedTasks,
          pending: pendingTasks,
          inProgress: inProgressTasks,
        },
        members: project.members.length,
      },
    };
  }

  async findProjectMembers(projectId: string): Promise<ProjectMember[]> {
    if (!isUuid(projectId)) return [];
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMember | null> {
    if (!isUuid(projectId) || !isUuid(userId)) return null;
    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async createProjectMember(
    projectId: string,
    userId: string,
    role: ProjectMemberRole | (string & {}),
  ): Promise<ProjectMember> {
    return this.prisma.projectMember.create({
      data: {
        projectId,
        userId,
        role: role as ProjectMemberRole,
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async updateProjectMemberRole(
    projectId: string,
    userId: string,
    role: ProjectMemberRole | (string & {}),
  ): Promise<ProjectMember> {
    return this.prisma.projectMember.update({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      data: { role: role as ProjectMemberRole },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async deleteProjectMember(projectId: string, userId: string): Promise<void> {
    await this.prisma.projectMember.delete({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
  }

  async countAdmins(projectId: string): Promise<number> {
    if (!isUuid(projectId)) return 0;
    return this.prisma.projectMember.count({
      where: {
        projectId,
        role: ProjectMemberRole.admin,
      },
    });
  }

  async findWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    if (!isUuid(workspaceId) || !isUuid(userId)) return null;
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    return member?.role || null;
  }
}
