import { Injectable, NotFoundException } from '@nestjs/common';
import { DashboardRepository } from './dashboard.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly dashboardRepo: DashboardRepository,
    private readonly cache: RedisCacheService,
  ) {}

  async globalSearch(workspaceId: string, query: string, _userId: string) {
    if (!query || !query.trim()) return [];

    const [projects, pages, files, stickies] = await Promise.all([
      this.dashboardRepo.searchProjects(workspaceId, query),
      this.dashboardRepo.searchPages(workspaceId, query),
      this.dashboardRepo.searchFiles(workspaceId, query),
      this.dashboardRepo.searchStickies(workspaceId, query),
    ]);

    return [
      ...projects.map((p) => ({
        type: 'project',
        id: p.id,
        name: p.name,
        icon: p.avatar || null,
        updatedAt: p.updatedAt,
      })),
      ...pages.map((p) => ({
        type: 'page',
        id: p.id,
        name: p.title,
        projectId: p.projectId,
        projectName: p.project?.name,
        updatedAt: p.updatedAt,
      })),
      ...files.map((f) => ({
        type: f.isFolder ? 'folder' : 'file',
        id: f.id,
        name: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        updatedAt: f.updatedAt,
      })),
      ...stickies.map((s) => ({
        type: 'sticky',
        id: s.id,
        name: s.title || 'Untitled',
        content: s.content?.substring(0, 80) || '',
        color: s.color,
        updatedAt: s.updatedAt,
      })),
    ];
  }

  async getRecentItems(workspaceId: string, _userId: string) {
    const [projects, pages, files] = await Promise.all([
      this.dashboardRepo.findRecentProjects(workspaceId),
      this.dashboardRepo.findRecentPages(workspaceId),
      this.dashboardRepo.findRecentFiles(workspaceId),
    ]);

    const recentProjects = projects.map((p) => ({
      type: 'project',
      id: p.id,
      name: p.name,
      icon: 'Folder',
      lastEdited: p.updatedAt,
      author: p.createdById,
    }));

    const recentPages = pages.map((p) => ({
      type: 'page',
      id: p.id,
      name: p.title,
      icon: 'FileText',
      lastEdited: p.updatedAt,
      author: p.authorId,
      project: p.project
        ? { id: p.project.id, name: p.project.name }
        : undefined,
    }));

    const recentFiles = files.map((f) => ({
      type: 'file',
      id: f.id,
      name: f.filename,
      icon: 'File',
      lastEdited: f.updatedAt,
      author: f.authorId,
    }));

    return [...recentProjects, ...recentPages, ...recentFiles]
      .sort(
        (a, b) =>
          new Date(b.lastEdited).getTime() - new Date(a.lastEdited).getTime(),
      )
      .slice(0, 10);
  }

  async getActivityFeed(workspaceId: string) {
    const [pages, files, tasks] = await Promise.all([
      this.dashboardRepo.findRecentPages(workspaceId),
      this.dashboardRepo.findRecentFilesCreated(workspaceId),
      this.dashboardRepo.findRecentTasks(workspaceId),
    ]);

    const pageActivities = pages.map((p) => ({
      type: 'page_update',
      user: p.authorId,
      content: `updated document "${p.title}"`,
      time: p.updatedAt,
      itemId: p.id,
      project: p.project
        ? { id: p.project.id, name: p.project.name }
        : undefined,
    }));

    const fileActivities = files.map((f) => ({
      type: 'file_upload',
      user: f.authorId,
      content: `uploaded file "${f.filename}"`,
      time: f.createdAt,
      itemId: f.id,
    }));

    const taskActivities = tasks.map((t) => ({
      type: 'task_update',
      user: t.authorId,
      content: `updated task "${t.title}"`,
      time: t.updatedAt,
      itemId: t.id,
      project: t.project
        ? { id: t.project.id, name: t.project.name }
        : undefined,
    }));

    return [...pageActivities, ...fileActivities, ...taskActivities]
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 15);
  }

  async getProjectOverview(projectId: string, _userId: string) {
    return this.cache.wrap(
      `dashboard:project:${projectId}:overview`,
      async () => {
        const project =
          await this.dashboardRepo.findProjectWithMembers(projectId);

        if (!project) {
          throw new NotFoundException('Project not found');
        }

        const [files, tasks] = await Promise.all([
          this.dashboardRepo.findProjectFiles(projectId),
          this.dashboardRepo.findProjectTasks(projectId),
        ]);

        const fileCount = files.length;
        const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);

        const taskCount = tasks.length;
        const completedTasks = tasks.filter((t) => t.completed).length;
        const inProgressTasks = tasks.filter(
          (t) => t.columnId === 'doing' || t.columnId === 'in_progress',
        ).length;
        const pendingTasks = taskCount - completedTasks - inProgressTasks;

        const stats = {
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
        };

        return {
          project,
          stats,
        };
      },
      60,
    );
  }

  async getWorkspaceOverview(workspaceId: string) {
    return this.cache.wrap(
      `dashboard:workspace:${workspaceId}:overview`,
      async () => {
        const stats = await this.dashboardRepo.countWorkspaceStats(workspaceId);
        return { stats };
      },
      60,
    );
  }

  async getYourWork(workspaceId: string, userId: string) {
    const [recent, activity] = await Promise.all([
      this.getRecentItems(workspaceId, userId),
      this.getActivityFeed(workspaceId),
    ]);

    return {
      workspaceId,
      userId,
      recent,
      activity,
      success: true,
    };
  }
}
