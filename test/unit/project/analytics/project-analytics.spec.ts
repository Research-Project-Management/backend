import { fromPartial } from '@total-typescript/shoehorn';
import type { RedisCacheService } from '@/core';
import { ActivityService } from '@/modules/project/activity/activity.service';
import { AnalyticsRepository } from '@/modules/project/analytics/analytics.repository';
import { AnalyticsService } from '@/modules/project/analytics/analytics.service';
import { buildWorkItemTimeSeries } from '@/modules/project/analytics/domain/analytics.domain';
import { YourWorkRepository } from '@/modules/project/your-work/your-work.repository';
import { YourWorkService } from '@/modules/project/your-work/your-work.service';

describe('Project Analytics & YourWork Aggregation Suite', () => {
  describe('AnalyticsService & Time Series Domain', () => {
    it('aggregates distributions across states, stateGroups, priority, assignees, and labels, and builds daily time series', async () => {
      const pastDate = new Date(Date.now() - 86400 * 1000 * 3);
      const repo = fromPartial<AnalyticsRepository>({
        findProjectStates: jest.fn().mockResolvedValue([
          { id: 'st-todo', name: 'To Do', group: 'unstarted', color: '#3B82F6', sequence: 1 },
          { id: 'st-prog', name: 'In Progress', group: 'started', color: '#F59E0B', sequence: 2 },
          { id: 'st-done', name: 'Done', group: 'completed', color: '#10B981', sequence: 3 },
        ]),
        findProjectWorkItemsWithAssignees: jest.fn().mockResolvedValue([
          {
            id: 'wi-1',
            columnId: 'st-todo',
            stateGroup: 'unstarted',
            priority: 'urgent',
            completed: false,
            dueDate: pastDate,
            assigneeId: 'u-1',
            assignee: { id: 'u-1', name: 'Alice', avatar: null },
            labelAssignments: [
              { label: { id: 'lbl-1', name: 'NLP', color: '#8B5CF6' } },
            ],
          },
          {
            id: 'wi-2',
            columnId: 'st-prog',
            stateGroup: 'started',
            priority: 'high',
            completed: false,
            dueDate: null,
            assigneeId: 'u-1',
            assignee: { id: 'u-1', name: 'Alice', avatar: null },
            labelAssignments: [
              { label: { id: 'lbl-1', name: 'NLP', color: '#8B5CF6' } },
            ],
          },
          {
            id: 'wi-3',
            columnId: 'st-done',
            stateGroup: 'completed',
            priority: 'medium',
            completed: true,
            dueDate: pastDate,
            assigneeId: null,
            assignee: null,
            labelAssignments: [],
          },
        ]),
      });

      const service = new AnalyticsService(
        repo,
        fromPartial<RedisCacheService>({
          wrap: jest.fn((_key, fn: () => Promise<unknown>) => fn()) as never,
        }),
      );

      const result = await service.getProjectAnalytics('proj-1');
      expect(result).toMatchObject({
        totalItems: 3,
        completedItems: 1,
        inProgressItems: 1,
        overdueItems: 1,
        unassignedItems: 1,
        completionRate: 33,
        stateGroups: {
          backlog: 0,
          unstarted: 1,
          started: 1,
          completed: 1,
          cancelled: 0,
        },
        labels: [{ id: 'lbl-1', label: 'NLP', color: '#8B5CF6', count: 2 }],
      });
      expect(result.assignee[0]).toMatchObject({
        userId: 'u-1',
        name: 'Alice',
        count: 2,
        inProgressCount: 1,
        overdueCount: 1,
      });

      const series = buildWorkItemTimeSeries(
        [
          {
            createdAt: new Date('2026-11-01T10:00:00.000Z'),
            updatedAt: new Date('2026-11-02T14:00:00.000Z'),
            completed: true,
          },
        ],
        new Date('2026-11-01T00:00:00.000Z'),
        new Date('2026-11-03T23:59:59.999Z'),
      );
      expect(series).toEqual([
        { date: '2026-11-01', created: 1, completed: 0 },
        { date: '2026-11-02', created: 0, completed: 1 },
        { date: '2026-11-03', created: 0, completed: 0 },
      ]);
    });
  });

  describe('YourWorkService', () => {
    it('aggregates assigned/created work items, profile metadata, and falls back to userFeed when projectId is omitted', async () => {
      const getUserFeed = jest.fn().mockResolvedValue({ items: [] });
      const service = new YourWorkService(
        fromPartial<YourWorkRepository>({
          findUserWorkItems: jest.fn().mockResolvedValue([
            {
              id: 'wi-1',
              title: 'WorkItem 1',
              identifier: 'PRJ-1',
              priority: 'high',
              assigneeId: 'user-1',
              authorId: 'user-2',
              columnId: 'todo',
              projectId: 'prj-1',
              comments: [],
              project: {
                id: 'prj-1',
                name: 'Project Alpha',
                identifier: 'PRJ',
                avatar: null,
                states: [{ id: 'todo', name: 'To Do', group: 'unstarted' }],
              },
            },
            {
              id: 'wi-2',
              title: 'WorkItem 2',
              identifier: 'PRJ-2',
              priority: 'urgent',
              assigneeId: 'user-2',
              authorId: 'user-1',
              columnId: 'done',
              projectId: 'prj-1',
              comments: [],
              project: {
                id: 'prj-1',
                name: 'Project Alpha',
                identifier: 'PRJ',
                avatar: null,
                states: [{ id: 'done', name: 'Done', group: 'completed' }],
              },
            },
          ]),
          findUserProjects: jest.fn().mockResolvedValue([]),
          findUserProfile: jest.fn().mockResolvedValue({
            id: 'user-1',
            name: 'Test User',
            email: 'test@example.com',
            avatar: null,
            createdAt: new Date('2026-03-04T00:00:00Z'),
          }),
          checkProjectAccess: jest.fn().mockResolvedValue({
            exists: true,
            hasAccess: true,
          }),
        }),
        fromPartial<ActivityService>({
          getProjectFeed: jest.fn().mockResolvedValue({ items: [] }),
          getUserFeed,
          getRecentItems: jest.fn().mockResolvedValue([]),
        }),
      );

      const scoped = await service.getYourWork('prj-1', 'user-1');
      expect(scoped.success).toBe(true);
      expect(scoped.assigned.map((w) => w.id)).toEqual(['wi-1']);
      expect(scoped.created.map((w) => w.id)).toEqual(['wi-2']);
      expect(scoped.userData?.email).toBe('test@example.com');
      expect(scoped.projectBreakdown?.[0]?.projectName).toBe('Project Alpha');

      await service.getYourWork(undefined, 'user-1');
      expect(getUserFeed).toHaveBeenCalledWith('user-1', { limit: 20 });
    });
  });
});
