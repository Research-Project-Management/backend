import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async countWorkspaceStats(workspaceId: string) {
    const [
      membersCount,
      projectsCount,
      tasksCount,
      papersCount,
      pagesCount,
      filesCount,
      stickiesCount,
    ] = await Promise.all([
      this.prisma.workspaceMember.count({ where: { workspaceId } }),
      this.prisma.project.count({
        where: { workspaceId, isActive: true },
      }),
      this.prisma.task.count({
        where: { project: { workspaceId } },
      }),
      this.prisma.catalogItem.count({
        where: { workspaceId, deletedAt: null },
      }),
      this.prisma.page.count({
        where: {
          OR: [{ workspaceId }, { project: { workspaceId } }],
          deletedAt: null,
        },
      }),
      this.prisma.file.count({
        where: { workspaceId, trashedAt: null },
      }),
      this.prisma.sticky.count({ where: { workspaceId } }),
    ]);

    return {
      members: membersCount,
      projects: projectsCount,
      tasks: tasksCount,
      papers: papersCount,
      pages: pagesCount,
      files: filesCount,
      stickies: stickiesCount,
    };
  }

  async findProjectTasksWithAssignees(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId },
      select: {
        id: true,
        columnId: true,
        priority: true,
        completed: true,
        assigneeId: true,
        assignee: { select: USER_SELECT },
      },
    });
  }

  async findCycleTasks(cycleId: string) {
    return this.prisma.task.findMany({
      where: { cycleId },
      select: {
        id: true,
        columnId: true,
        completed: true,
        priority: true,
      },
    });
  }

  async findUserWorkspaceTasks(workspaceId: string, userId: string) {
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId },
        OR: [
          { assigneeId: userId },
          { authorId: userId },
          { comments: { some: { authorId: userId } } },
        ],
      },
      include: {
        author: { select: USER_SELECT },
        assignee: { select: USER_SELECT },
        project: { select: { id: true, name: true, avatar: true } },
        comments: { select: { id: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
