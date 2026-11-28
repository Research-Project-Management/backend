import { NotFoundException } from '@nestjs/common';
import type { RedisCacheService } from '@/core';
import { BffCacheService } from '@/modules/bff/bff.cache';
import { BffSectionCircuitBreaker } from '@/modules/bff/bff.resilience';
import { BffService } from '@/modules/bff/bff.service';
import type { EditorBootstrapService } from '@/modules/pages';
import type { ChatService } from '@/modules/project/chat/services/chat.service';
import type { ProjectChannelService } from '@/modules/project/chat/services/project-channel.service';
import type { CoreService } from '@/modules/project/core/core.service';
import type { OverviewService } from '@/modules/project/overview/overview.service';
import type { YourWorkService } from '@/modules/project/your-work/your-work.service';

describe('BffService Seam', () => {
  let service: BffService;
  let bffCache: BffCacheService;
  let circuitBreaker: BffSectionCircuitBreaker;
  let redisStore: Map<string, unknown>;
  let redisCacheMock: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    delPattern: jest.Mock;
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
      get: jest.fn(async (key: string) =>
        redisStore.has(key) ? redisStore.get(key) : null,
      ),
      set: jest.fn(async (key: string, value: unknown) => {
        redisStore.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        redisStore.delete(key);
      }),
      delPattern: jest.fn(async () => undefined),
    };

    bffCache = new BffCacheService(
      redisCacheMock as unknown as RedisCacheService,
    );
    circuitBreaker = new BffSectionCircuitBreaker();
    projectCoreService = { findUserProjects: jest.fn() };
    overviewService = { getProjectOverview: jest.fn() };
    yourWorkService = { getYourWork: jest.fn() };
    chatService = { getUserConversations: jest.fn() };
    projectChannelService = { getProjectChannels: jest.fn() };
    editorBootstrapService = { bootstrapEditor: jest.fn() };

    service = new BffService(
      projectCoreService as unknown as CoreService,
      overviewService as unknown as OverviewService,
      yourWorkService as unknown as YourWorkService,
      chatService as unknown as ChatService,
      projectChannelService as unknown as ProjectChannelService,
      bffCache,
      editorBootstrapService as unknown as EditorBootstrapService,
      circuitBreaker,
    );
  });

  describe('getWorkspaceShell (cache, Singleflight, CircuitBreaker & section timeout)', () => {
    it('normalizes projects/chat unread counts, serves cached generatedAt, and writes back on bypassCache', async () => {
      projectCoreService.findUserProjects.mockResolvedValue({
        projects: [
          { id: 'p1', name: 'Flux' },
          { id: 'p2', name: 'Shared' },
        ],
        myProjects: [{ id: 'p1', name: 'Flux' }],
        sharedProjects: [{ id: 'p2', name: 'Shared' }],
        total: 2,
      });
      yourWorkService.getYourWork.mockResolvedValue({ assignedCount: 4 });
      chatService.getUserConversations.mockResolvedValue({
        directs: [{ id: 'c1', unreadCount: 3 }],
        groups: [{ id: 'c2', unreadCount: 2 }],
        projectChannels: [{ id: 'c3', unreadCount: 1 }],
      });

      const first = await service.getWorkspaceShell('user-1');
      expect(first.data.projects).toEqual({
        items: [
          { id: 'p1', name: 'Flux' },
          { id: 'p2', name: 'Shared' },
        ],
        myProjectIds: ['p1'],
        sharedProjectIds: ['p2'],
        total: 2,
      });
      expect(first.data.chat).toEqual({
        totalConversations: 3,
        totalUnreadCount: 6,
      });
      expect(first.meta.cacheHit).toBe(false);

      const cached = await service.getWorkspaceShell('user-1');
      expect(cached.meta.cacheHit).toBe(true);
      expect(cached.meta.generatedAt).toBe(first.meta.generatedAt);
      expect(projectCoreService.findUserProjects).toHaveBeenCalledTimes(1);

      projectCoreService.findUserProjects.mockResolvedValueOnce({
        projects: [{ id: 'p3', name: 'Fresh' }],
        myProjects: [{ id: 'p3', name: 'Fresh' }],
        sharedProjects: [],
        total: 1,
      });
      const refreshed = await service.getWorkspaceShell('user-1', {
        bypassCache: true,
      });
      expect(refreshed.meta.cacheHit).toBe(false);
      expect(refreshed.data.projects.total).toBe(1);

      const afterRefresh = await service.getWorkspaceShell('user-1');
      expect(afterRefresh.meta.cacheHit).toBe(true);
      expect(afterRefresh.data.projects.total).toBe(1);
    });

    it('coalesces concurrent cold-cache requests via Singleflight and clears inFlight on rejection', async () => {
      projectCoreService.findUserProjects.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  projects: [{ id: 'p1', name: 'Flux' }],
                  myProjects: [{ id: 'p1', name: 'Flux' }],
                  sharedProjects: [],
                  total: 1,
                }),
              20,
            ),
          ),
      );
      yourWorkService.getYourWork.mockResolvedValue({ assignedCount: 1 });
      chatService.getUserConversations.mockResolvedValue({
        directs: [],
        groups: [],
        projectChannels: [],
      });

      const results = await Promise.all([
        service.getWorkspaceShell('user-1'),
        service.getWorkspaceShell('user-1'),
        service.getWorkspaceShell('user-1'),
      ]);
      expect(results).toHaveLength(3);
      expect(projectCoreService.findUserProjects).toHaveBeenCalledTimes(1);
      expect(bffCache.getInFlightCount()).toBe(0);

      projectCoreService.findUserProjects.mockRejectedValueOnce(
        new Error('db failure'),
      );
      await expect(service.getWorkspaceShell('user-2')).rejects.toThrow(
        'db failure',
      );
      expect(bffCache.getInFlightCount()).toBe(0);
    });

    it('degrades optional sections without caching partial payloads, opens CircuitBreaker after 3 failures, and enforces timeouts', async () => {
      projectCoreService.findUserProjects.mockResolvedValue({
        projects: [],
        myProjects: [],
        sharedProjects: [],
        total: 0,
      });
      yourWorkService.getYourWork.mockResolvedValue({ assignedCount: 0 });
      chatService.getUserConversations.mockRejectedValue(
        new Error('chat service down'),
      );

      await service.getWorkspaceShell('user-1');
      await service.getWorkspaceShell('user-1');
      const third = await service.getWorkspaceShell('user-1');
      expect(third.meta.circuitOpenSections).toEqual(['chat']);

      const fourth = await service.getWorkspaceShell('user-1');
      expect(fourth.meta.partial).toBe(true);
      expect(fourth.meta.circuitOpenSections).toEqual(['chat']);
      expect(chatService.getUserConversations).toHaveBeenCalledTimes(3);
      expect(redisCacheMock.set).not.toHaveBeenCalled();

      // Section timeout enforcement
      const fastTimeoutService = new BffService(
        projectCoreService as unknown as CoreService,
        overviewService as unknown as OverviewService,
        yourWorkService as unknown as YourWorkService,
        chatService as unknown as ChatService,
        projectChannelService as unknown as ProjectChannelService,
        bffCache,
        editorBootstrapService as unknown as EditorBootstrapService,
        new BffSectionCircuitBreaker(),
        25,
      );
      chatService.getUserConversations.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            const t = setTimeout(
              () => resolve({ directs: [], groups: [], projectChannels: [] }),
              200,
            );
            t.unref();
          }),
      );

      const timedOut = await fastTimeoutService.getWorkspaceShell('user-9');
      expect(timedOut.meta.partial).toBe(true);
      expect(timedOut.meta.timedOutSections).toEqual(['chat']);
    });
  });

  describe('getProjectBootstrap & getEditorBootstrap', () => {
    it('aggregates project overview + shaped channels, propagates NotFoundException, and wraps EditorBootstrap envelope', async () => {
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
          isDefault: true,
          memberCount: 3,
          unreadCount: 1,
          isMuted: false,
          isPinned: true,
          updatedAt: '2026-11-25T00:00:00.000Z',
        },
      ]);

      const projBootstrap = await service.getProjectBootstrap(
        'proj-1',
        'user-1',
      );
      expect(projBootstrap.data.overview).toEqual({
        id: 'proj-1',
        name: 'Research Paper',
      });
      expect(projBootstrap.data.channels).toEqual([
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
      expect(projBootstrap.meta.partial).toBe(false);

      overviewService.getProjectOverview.mockRejectedValueOnce(
        new NotFoundException('Project not found'),
      );
      await expect(
        service.getProjectBootstrap('missing-proj', 'user-1'),
      ).rejects.toThrow(NotFoundException);

      editorBootstrapService.bootstrapEditor.mockResolvedValue({
        tree: [],
        degraded: true,
        degradedBranches: ['lastBuild'],
        serverTimestamp: '2026-11-25T07:00:00.000Z',
      });
      const editorRes = await service.getEditorBootstrap({
        pageOrProjectId: 'page-1',
        userId: 'user-1',
      });
      expect(editorRes.meta).toMatchObject({
        channel: 'web',
        partial: true,
        degradedSections: ['lastBuild'],
        generatedAt: '2026-11-25T07:00:00.000Z',
      });
    });
  });

  describe('BffSectionCircuitBreaker & BffCacheService invalidation', () => {
    it('enforces single-probe HALF_OPEN lock without mutating on getStats, and invalidates caches on domain events', async () => {
      let nowMs = 1_000;
      const breaker = new BffSectionCircuitBreaker(2, 10_000, () => nowMs);

      breaker.recordFailure('chat');
      breaker.recordFailure('chat');
      expect(breaker.getState('chat')).toBe('OPEN');
      expect(breaker.tryAcquire('chat')).toBe(false);

      nowMs += 10_001;
      expect(breaker.getStats()).toEqual([
        {
          section: 'chat',
          state: 'HALF_OPEN',
          consecutiveFailures: 2,
          halfOpenInFlight: false,
        },
      ]);
      expect(breaker.tryAcquire('chat')).toBe(true);
      expect(breaker.tryAcquire('chat')).toBe(false);

      breaker.recordFailure('chat');
      expect(breaker.getState('chat')).toBe('OPEN');

      nowMs += 10_001;
      expect(breaker.tryAcquire('chat')).toBe(true);
      breaker.recordSuccess('chat');
      expect(breaker.getState('chat')).toBe('CLOSED');

      // Event-driven cache invalidation
      await bffCache.handleProjectChanged({
        entityId: 'proj-42',
        actorId: 'owner-1',
        verb: 'member_added',
        newValue: 'member-2',
      });
      expect(redisCacheMock.delPattern).toHaveBeenCalledWith(
        'flux:bff:web:project-bootstrap:proj-42:*',
      );
      expect(redisCacheMock.del).toHaveBeenCalledWith(
        'flux:bff:web:workspace-shell:owner-1',
      );
      expect(redisCacheMock.del).toHaveBeenCalledWith(
        'flux:bff:web:workspace-shell:member-2',
      );

      redisCacheMock.delPattern.mockRejectedValueOnce(new Error('redis down'));
      await expect(
        bffCache.handleWorkItemChanged({
          projectId: 'proj-99',
          actorId: 'actor-7',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
