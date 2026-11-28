import { NotFoundException } from '@nestjs/common';
import type { RedisCacheService } from '@/core';
import { BffCacheService } from '@/modules/bff/bff.cache';
import { BffSectionCircuitBreaker } from '@/modules/bff/bff.resilience';
import { BffService } from '@/modules/bff/bff.service';
import type { CoreService } from '@/modules/project/core/core.service';
import type { OverviewService } from '@/modules/project/overview/overview.service';
import type { YourWorkService } from '@/modules/project/your-work/your-work.service';
import type { ChatService } from '@/modules/project/chat/services/chat.service';
import type { ProjectChannelService } from '@/modules/project/chat/services/project-channel.service';
import type { EditorBootstrapService } from '@/modules/pages/bootstrap/editor-bootstrap.service';

describe('BffService', () => {
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
      delPattern: jest.fn(() => Promise.resolve()),
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

  describe('getWorkspaceShell', () => {
    it('normalizes projects, preserves generatedAt on cache hit, and writes back on refresh', async () => {
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
      expect(first.meta.cacheHit).toBe(false);

      // Cache hit preserves original generatedAt
      const second = await service.getWorkspaceShell('user-1');
      expect(second.meta.cacheHit).toBe(true);
      expect(second.meta.generatedAt).toBe(first.meta.generatedAt);
      expect(projectCoreService.findUserProjects).toHaveBeenCalledTimes(1);

      // ?refresh=true bypasses read AND refreshes Redis cache so next normal read gets fresh data
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

    it('coalesces concurrent cold-cache requests via Singleflight and cleans inFlight on error', async () => {
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
              25,
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

      // Verify inFlight is cleaned up when compute rejects
      projectCoreService.findUserProjects.mockRejectedValueOnce(
        new Error('db failure'),
      );
      await expect(service.getWorkspaceShell('user-2')).rejects.toThrow(
        'db failure',
      );
      expect(bffCache.getInFlightCount()).toBe(0);
    });

    it('degrades gracefully on optional errors and opens Circuit Breaker after 3 failures', async () => {
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
      expect(chatService.getUserConversations).toHaveBeenCalledTimes(3);

      const fourth = await service.getWorkspaceShell('user-1');
      expect(fourth.meta.partial).toBe(true);
      expect(fourth.meta.circuitOpenSections).toEqual(['chat']);
      expect(chatService.getUserConversations).toHaveBeenCalledTimes(3);
      expect(redisCacheMock.set).not.toHaveBeenCalled();
    });

    it('enforces per-section timeout via constructor-injected deadline', async () => {
      const fastTimeoutService = new BffService(
        projectCoreService as unknown as CoreService,
        overviewService as unknown as OverviewService,
        yourWorkService as unknown as YourWorkService,
        chatService as unknown as ChatService,
        projectChannelService as unknown as ProjectChannelService,
        bffCache,
        editorBootstrapService as unknown as EditorBootstrapService,
        circuitBreaker,
        25,
      );

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

      const result = await fastTimeoutService.getWorkspaceShell('user-1');

      expect(result.meta.partial).toBe(true);
      expect(result.meta.degradedSections).toEqual(['chat']);
      expect(result.meta.timedOutSections).toEqual(['chat']);
    });
  });

  describe('getProjectBootstrap & getEditorBootstrap', () => {
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
      expect(result.data.channels).toHaveLength(1);
      expect(result.meta.partial).toBe(false);
    });

    it('propagates critical overview errors (NotFoundException)', async () => {
      overviewService.getProjectOverview.mockRejectedValue(
        new NotFoundException('Project not found'),
      );
      projectChannelService.getProjectChannels.mockResolvedValue([]);

      await expect(
        service.getProjectBootstrap('missing-proj', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('wraps EditorBootstrapService response in the canonical BFF envelope', async () => {
      editorBootstrapService.bootstrapEditor.mockResolvedValue({
        tree: [],
        degraded: true,
        degradedBranches: ['lastBuild'],
        serverTimestamp: '2026-11-25T07:00:00.000Z',
      });

      const result = await service.getEditorBootstrap({
        pageOrProjectId: 'page-1',
        userId: 'user-1',
      });

      expect(result.meta.channel).toBe('web');
      expect(result.meta.partial).toBe(true);
      expect(result.meta.degradedSections).toEqual(['lastBuild']);
      expect(result.meta.generatedAt).toBe('2026-11-25T07:00:00.000Z');
    });
  });

  describe('BffSectionCircuitBreaker single-probe HALF_OPEN lock & pure getStats', () => {
    it('allows only 1 concurrent canary probe in HALF_OPEN and never mutates on getStats', () => {
      let nowMs = 1_000;
      const breaker = new BffSectionCircuitBreaker(2, 10_000, () => nowMs);

      breaker.recordFailure('chat');
      breaker.recordFailure('chat');
      expect(breaker.getState('chat')).toBe('OPEN');
      expect(breaker.tryAcquire('chat')).toBe(false);

      // Advance past cooldown: getStats() reads HALF_OPEN without locking halfOpenInFlight
      nowMs += 10_001;
      const statsBefore = breaker.getStats();
      expect(statsBefore).toEqual([
        {
          section: 'chat',
          state: 'HALF_OPEN',
          consecutiveFailures: 2,
          halfOpenInFlight: false,
        },
      ]);

      // First caller acquires the single HALF_OPEN canary probe
      expect(breaker.tryAcquire('chat')).toBe(true);
      // Concurrent second caller is rejected immediately (prevents thundering herd)
      expect(breaker.tryAcquire('chat')).toBe(false);

      // Probe failure re-opens circuit and releases lock
      breaker.recordFailure('chat');
      expect(breaker.getState('chat')).toBe('OPEN');

      // After next cooldown, probe succeeds -> CLOSED
      nowMs += 10_001;
      expect(breaker.tryAcquire('chat')).toBe(true);
      breaker.recordSuccess('chat');
      expect(breaker.getState('chat')).toBe('CLOSED');
    });
  });

  describe('BffCacheService event-driven invalidation (DomainActivityEvent actorId)', () => {
    it('evicts project bootstrap and affected users using actorId on project.** events', async () => {
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
    });

    it('evicts project and actor BFF caches on work-item.** events and survives Redis errors', async () => {
      await bffCache.handleWorkItemChanged({
        projectId: 'proj-99',
        actorId: 'actor-7',
      });

      expect(redisCacheMock.delPattern).toHaveBeenCalledWith(
        'flux:bff:web:project-bootstrap:proj-99:*',
      );
      expect(redisCacheMock.del).toHaveBeenCalledWith(
        'flux:bff:web:workspace-shell:actor-7',
      );

      // Redis failure does not throw unhandled rejection
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
