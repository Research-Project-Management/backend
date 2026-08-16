import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, ProjectMemberRole } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type ProjectWithMembers = Prisma.ProjectGetPayload<{
  include: {
    members: {
      include: {
        user: { select: typeof USER_SELECT };
      };
    };
  };
}> & {
  workspace?: {
    id: string;
    name: string;
    url: string;
  };
};

@Injectable()
export class ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: { OR: [{ id: workspaceIdOrSlug }, { url: workspaceIdOrSlug }] },
      select: { id: true },
    });
  }

  async findWorkspaceProjects(workspaceId: string) {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.project.findMany({
      where: { workspaceId: targetId, isActive: true },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findProjectById(projectId: string): Promise<ProjectWithMembers | null> {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
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
      },
    });
  }

  async deleteProject(projectId: string) {
    return this.prisma.project.delete({ where: { id: projectId } });
  }

  async findProjectOverview(projectId: string) {
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

  async findProjectMembers(projectId: string) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async findProjectMember(projectId: string, userId: string) {
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
  ) {
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
  ) {
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

  async deleteProjectMember(projectId: string, userId: string) {
    return this.prisma.projectMember.delete({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
  }
}
