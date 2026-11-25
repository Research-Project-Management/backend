import { NotFoundException } from '@nestjs/common';
import type { RedisCacheService } from '@/core';
import { BffCacheService } from '@/modules/bff/core/bff-cache.service';
import { WebBffService } from '@/modules/bff/web/web-bff.service';
import type { CoreService } from '@/modules/project/core/core.service';
import type { OverviewService } from '@/modules/project/overview/overview.service';
import type { YourWorkService } from '@/modules/project/your-work/your-work.service';
import type { ChatService } from '@/modules/chat/services/chat.service';
import type { ProjectChannelService } from '@/modules/chat/services/project-channel.service';
import type { EditorBootstrapService } from '@/modules/pages/bootstrap/editor-bootstrap.service';

describe('WebBffService (Standardized 5-Subsystem BFF)', () => {
  let service: WebBffService;
  let bffCache: BffCacheService;
  let redisStore: Map<string, unknown>;
  let redisCacheMock: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
  let projectCoreService: { findUserProjects: jest.Mock };
  let overviewService: { getProjectOverview: jest.Mock };
  let yourWorkService: { getYourWork: jest.Mock };
  let chatService: { getUserConversations: jest.Mock };
  let projectChannelService: { getProjectChannels: jest.Mock };
  let editorBootstrapService: { bootstrapEditor: jest.Mock };

  beforeEach(() => {
    redisStore = new Map<string, unknown>();
    redisCacheMock = {
      get: jest.fn((key: string) =>
        Promise.resolve(redisStore.has(key) ? redisStore.get(key) : null),
      ),
      set: jest.fn((key: string, value: unknown) => {
        redisStore.set(key, value);
        return Promise.resolve();
      }),
      del: jest.fn((key: string) => {
        redisStore.delete(key);
        return Promise.resolve();
      }),
    };

    bffCache = new BffCacheService(
      redisCacheMock as unknown as RedisCacheService,
    );
    projectCoreService = { findUserProjects: jest.fn() };
    overviewService = { getProjectOverview: jest.fn() };
    yourWorkService = { getYourWork: jest.fn() };
    chatService = { getUserConversations: jest.fn() };
    projectChannelService = { getProjectChannels: jest.fn() };
    editorBootstrapService = { bootstrapEditor: jest.fn() };

    service = new WebBffService(
      projectCoreService as unknown as CoreService,
      overviewService as unknown as OverviewService,
      yourWorkService as unknown as YourWorkService,
      chatService as unknown as ChatService,
      projectChannelService as unknown as ProjectChannelService,
      bffCache,
      editorBootstrapService as unknown as EditorBootstrapService,
    );
  });

  describe('getWorkspaceShell', () => {
    it('aggregates projects, yourWork, and chat summary and caches clean responses', async () => {
      projectCoreService.findUserProjects.mockResolvedValue({
        projects: [{ id: 'p1', name: 'Flux' }],
        myProjects: [{ id: 'p1', name: 'Flux' }],
        sharedProjects: [],
        total: 1,
      });
      yourWorkService.getYourWork.mockResolvedValue({
        assignedCount: 4,
      });
      chatService.getUserConversations.mockResolvedValue({
        directs: [{ id: 'c1', unreadCount: 3 }],
        groups: [{ id: 'c2', unreadCount: 2 }],
        projectChannels: [{ id: 'c3', unreadCount: 1 }],
      });

      const first = await service.getWorkspaceShell('user-1');
      expect(first.data.projects.total).toBe(1);
      expect(first.data.yourWork).toEqual({ assignedCount: 4 });
      expect(first.data.chat).toEqual({
        totalConversations: 3,
        totalUnreadCount: 6,
      });
      expect(first.meta.channel).toBe('web');
      expect(first.meta.partial).toBe(false);
      expect(first.meta.cacheHit).toBe(false);
      expect(first.meta.degradedSections).toEqual([]);
      expect(first.meta.timedOutSections).toEqual([]);

      // Second call hits channel cache without re-querying downstream services
      const second = await service.getWorkspaceShell('user-1');
      expect(second.meta.cacheHit).toBe(true);
      expect(second.data.chat.totalUnreadCount).toBe(6);
      expect(projectCoreService.findUserProjects).toHaveBeenCalledTimes(1);

      // bypassCache=true forces fresh aggregation
      const third = await service.getWorkspaceShell('user-1', {
        bypassCache: true,
      });
      expect(third.meta.cacheHit).toBe(false);
      expect(projectCoreService.findUserProjects).toHaveBeenCalledTimes(2);
    });

    it('degrades gracefully on optional errors and never caches partial payloads', async () => {
      projectCoreService.findUserProjects.mockResolvedValue({
        projects: [],
        myProjects: [],
        sharedProjects: [],
        total: 0,
      });
      yourWorkService.getYourWork.mockRejectedValue(
        new Error('analytics down'),
      );
      chatService.getUserConversations.mockRejectedValue(
        new Error('chat timeout'),
      );

      const result = await service.getWorkspaceShell('user-1');

      expect(result.data.projects.total).toBe(0);
      expect(result.data.yourWork).toBeNull();
      expect(result.data.chat).toEqual({
        totalConversations: 0,
        totalUnreadCount: 0,
      });
      expect(result.meta.partial).toBe(true);
      expect(result.meta.cacheHit).toBe(false);
      expect(result.meta.degradedSections).toEqual(['yourWork', 'chat']);
      expect(result.meta.timedOutSections).toEqual([]);
      expect(redisCacheMock.set).not.toHaveBeenCalled();
    });

    it('enforces per-section timeout and reports timedOutSections', async () => {
      projectCoreService.findUserProjects.mockResolvedValue({
        projects: [],
        myProjects: [],
        sharedProjects: [],
        total: 0,
      });
      yourWorkService.getYourWork.mockResolvedValue({ assignedCount: 0 });
      chatService.getUserConversations.mockImplementation(
        () =>
          new Promise((resolve) => {
            const t = setTimeout(
              () => resolve({ directs: [], groups: [], projectChannels: [] }),
              200,
            );
            t.unref();
          }),
      );

      const result = await service.getWorkspaceShell('user-1', {
        sectionTimeoutMs: 25,
      });

      expect(result.meta.partial).toBe(true);
      expect(result.meta.degradedSections).toEqual(['chat']);
      expect(result.meta.timedOutSections).toEqual(['chat']);
      expect(result.data.chat).toEqual({
        totalConversations: 0,
        totalUnreadCount: 0,
      });
    });
  });

  describe('getProjectBootstrap', () => {
    it('aggregates project overview and shaped project chat channels', async () => {
      overviewService.getProjectOverview.mockResolvedValue({
        id: 'proj-1',
        name: 'Research Paper',
      });
      projectChannelService.getProjectChannels.mockResolvedValue([
        {
          id: 'ch-1',
          type: 'project_channel',
          name: 'general',
          topic: 'Main',
          avatar: null,
          projectId: 'proj-1',
          projectName: 'Research Paper',
          projectIdentifier: 'RP',
          isDefault: true,
          memberCount: 3,
          unreadCount: 1,
          isMuted: false,
          isPinned: true,
          updatedAt: '2026-11-25T00:00:00.000Z',
        },
      ]);

      const result = await service.getProjectBootstrap('proj-1', 'user-1');

      expect(result.data.overview).toEqual({
        id: 'proj-1',
        name: 'Research Paper',
      });
      expect(result.data.channels).toEqual([
        {
          id: 'ch-1',
          name: 'general',
          topic: 'Main',
          isDefault: true,
          memberCount: 3,
          unreadCount: 1,
          isMuted: false,
          isPinned: true,
          updatedAt: '2026-11-25T00:00:00.000Z',
        },
      ]);
      expect(result.meta.partial).toBe(false);
      expect(result.meta.cacheHit).toBe(false);
    });

    it('degrades channels cleanly while preserving overview', async () => {
      overviewService.getProjectOverview.mockResolvedValue({
        id: 'proj-1',
        name: 'Research Paper',
      });
      projectChannelService.getProjectChannels.mockRejectedValue(
        new Error('chat unavailable'),
      );

      const result = await service.getProjectBootstrap('proj-1', 'user-1');

      expect(result.data.overview).toEqual({
        id: 'proj-1',
        name: 'Research Paper',
      });
      expect(result.data.channels).toEqual([]);
      expect(result.meta.partial).toBe(true);
      expect(result.meta.degradedSections).toEqual(['channels']);
      expect(redisCacheMock.set).not.toHaveBeenCalled();
    });

    it('propagates critical overview errors (e.g. NotFoundException)', async () => {
      overviewService.getProjectOverview.mockRejectedValue(
        new NotFoundException('Project not found'),
      );
      projectChannelService.getProjectChannels.mockResolvedValue([]);

      await expect(
        service.getProjectBootstrap('missing-proj', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getEditorBootstrap', () => {
    it('wraps EditorBootstrapService response in the standardized BFF envelope', async () => {
      editorBootstrapService.bootstrapEditor.mockResolvedValue({
        tree: [],
        degraded: true,
        degradedBranches: ['lastBuild'],
      });

      const result = await service.getEditorBootstrap({
        pageOrProjectId: 'page-1',
        userId: 'user-1',
      });

      expect(result.meta.channel).toBe('web');
      expect(result.meta.partial).toBe(true);
      expect(result.meta.degradedSections).toEqual(['lastBuild']);
      expect(result.data).toEqual({
        tree: [],
        degraded: true,
        degradedBranches: ['lastBuild'],
      });
    });
  });
});
