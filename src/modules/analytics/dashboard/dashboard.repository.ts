import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async searchProjects(workspaceId: string, query: string) {
    return this.prisma.project.findMany({
      where: {
        workspaceId,
        name: { contains: query, mode: 'insensitive' },
        isActive: true,
      },
      select: { id: true, name: true, avatar: true, updatedAt: true },
      take: 10,
    });
  }

  async searchPages(workspaceId: string, query: string) {
    return this.prisma.page.findMany({
      where: {
        workspaceId,
        title: { contains: query, mode: 'insensitive' },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        projectId: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
      take: 10,
    });
  }

  async searchFiles(workspaceId: string, query: string) {
    return this.prisma.file.findMany({
      where: {
        workspaceId,
        filename: { contains: query, mode: 'insensitive' },
        trashedAt: null,
      },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        isFolder: true,
        updatedAt: true,
      },
      take: 10,
    });
  }

  async searchStickies(workspaceId: string, query: string) {
    return this.prisma.sticky.findMany({
      where: {
        workspaceId,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { content: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        title: true,
        content: true,
        color: true,
        updatedAt: true,
      },
      take: 10,
    });
  }

  async findRecentProjects(workspaceId: string) {
    return this.prisma.project.findMany({
      where: { workspaceId, isActive: true },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        createdById: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
  }

  async findRecentPages(workspaceId: string) {
    return this.prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        title: true,
        projectId: true,
        authorId: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
  }

  async findRecentFiles(workspaceId: string) {
    return this.prisma.file.findMany({
      where: { workspaceId, trashedAt: null },
      select: {
        id: true,
        filename: true,
        authorId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
  }

  async findRecentFilesCreated(workspaceId: string) {
    return this.prisma.file.findMany({
      where: { workspaceId, trashedAt: null },
      select: {
        id: true,
        filename: true,
        authorId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  async findRecentTasks(workspaceId: string) {
    return this.prisma.task.findMany({
      where: { project: { workspaceId } },
      select: {
        id: true,
        title: true,
        authorId: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
  }

  async findProjectWithMembers(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async findProjectFiles(projectId: string) {
    return this.prisma.file.findMany({
      where: { linkedToId: projectId, trashedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findProjectTasks(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId },
    });
  }

  async countWorkspaceStats(workspaceId: string) {
    const [papers, files, projects, members] = await Promise.all([
      this.prisma.paper.count({
        where: { workspaceId, deletedAt: null },
      }),
      this.prisma.file.count({
        where: { workspaceId, trashedAt: null },
      }),
      this.prisma.project.count({
        where: { workspaceId, isActive: true },
      }),
      this.prisma.workspaceMember.count({
        where: { workspaceId },
      }),
    ]);

    return { papers, files, projects, members };
  }
}
