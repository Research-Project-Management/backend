import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
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
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  async findWorkspaceProjects(
    workspaceId: string,
  ): Promise<ProjectWithMembers[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.project.findMany({
      where: { workspaceId: targetId, isActive: true, deletedAt: null },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        lead: { select: USER_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findProjectById(projectId: string): Promise<ProjectWithMembers | null> {
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
    return this.prisma.project.findFirst({
      where: { workspaceId, identifier, deletedAt: null },
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

    const [files, tasks] = await Promise.all([
      this.prisma.file.findMany({
        where: { workspaceId: project.workspaceId, trashedAt: null },
        select: { id: true, filename: true, size: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      this.prisma.task.findMany({
        where: { projectId },
        select: { id: true, completed: true, columnId: true },
      }),
    ]);

    const fileCount = files.length;
    const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);

    const taskCount = tasks.length;
    const completedTasks = tasks.filter((t) => t.completed).length;
    const inProgressTasks = tasks.filter(
      (t) => t.columnId === 'doing' || t.columnId === 'in_progress',
    ).length;
    const pendingTasks = taskCount - completedTasks - inProgressTasks;

    return {
      project,
      stats: {
        files: {
          count: fileCount,
          totalSize,
          recent: files.slice(0, 5),
        },
        tasks: {
          total: taskCount,
          completed: completedTasks,
          pending: pendingTasks,
          inProgress: inProgressTasks,
        },
        members: project.members.length,
      },
    };
  }

  async findProjectMembers(projectId: string): Promise<ProjectMember[]> {
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
    return this.prisma.projectMember.count({
      where: {
        projectId,
        role: ProjectMemberRole.admin,
      },
    });
  }
}
