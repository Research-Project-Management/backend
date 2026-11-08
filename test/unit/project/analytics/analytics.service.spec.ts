import { AnalyticsService } from '@/modules/project/analytics/analytics.service';
import { AnalyticsRepository } from '@/modules/project/analytics/analytics.repository';
import {
  aggregateProjectDistributions,
  buildWorkItemTimeSeries,
} from '@/modules/project/analytics/domain/analytics.domain';

describe('Project Analytics Module (Service & Domain)', () => {
  let service: AnalyticsService;
  let mockRepo: any;
  let mockCache: any;

  beforeEach(() => {
    mockRepo = {
      findProjectWorkItemsWithAssignees: jest.fn(),
      findProjectStates: jest.fn(),
      countProjectStats: jest.fn(),
      countUserStats: jest.fn(),
      findProjectWorkItemsByLabel: jest.fn(),
      findProjectWorkItemsTimeSeries: jest.fn(),
    };
    mockCache = {
      wrap: jest.fn((_key, fn) => fn()),
    };
    service = new AnalyticsService(
      mockRepo as AnalyticsRepository,
      mockCache,
    );
  });

  it('should aggregate project distributions across states, stateGroups, priority, assignees, and labels', async () => {
    mockRepo.findProjectStates.mockResolvedValue([
      { id: 'st-todo', name: 'To Do', group: 'unstarted', color: '#3B82F6', sequence: 1 },
      { id: 'st-prog', name: 'In Progress', group: 'started', color: '#F59E0B', sequence: 2 },
      { id: 'st-done', name: 'Done', group: 'completed', color: '#10B981', sequence: 3 },
    ]);

    const pastDate = new Date(Date.now() - 86400 * 1000 * 3);
    mockRepo.findProjectWorkItemsWithAssignees.mockResolvedValue([
      {
        id: 'wi-1',
        columnId: 'st-todo',
        stateGroup: 'unstarted',
        priority: 'urgent',
        completed: false,
        dueDate: pastDate, // overdue
        assigneeId: 'u-1',
        assignee: { id: 'u-1', name: 'Alice', avatar: null },
        labelAssignments: [{ label: { id: 'lbl-1', name: 'NLP', color: '#8B5CF6' } }],
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
        labelAssignments: [{ label: { id: 'lbl-1', name: 'NLP', color: '#8B5CF6' } }],
      },
      {
        id: 'wi-3',
        columnId: 'st-done',
        stateGroup: 'completed',
        priority: 'medium',
        completed: true,
        dueDate: pastDate, // completed, so not overdue
        assigneeId: null,
        assignee: null,
        labelAssignments: [],
      },
    ]);

    const result = await service.getProjectAnalytics('proj-1');

    expect(result.totalItems).toBe(3);
    expect(result.completedItems).toBe(1);
    expect(result.inProgressItems).toBe(1);
    expect(result.overdueItems).toBe(1);
    expect(result.unassignedItems).toBe(1);
    expect(result.completionRate).toBe(33);
    expect(result.stateGroups).toEqual({
      backlog: 0,
      unstarted: 1,
      started: 1,
      completed: 1,
      cancelled: 0,
    });
    expect(result.states).toHaveLength(3);
    expect(result.assignee).toHaveLength(1);
    expect(result.assignee[0]).toMatchObject({
      userId: 'u-1',
      name: 'Alice',
      count: 2,
      completedCount: 0,
      inProgressCount: 1,
      overdueCount: 1,
    });
    expect(result.labels).toEqual([
      { id: 'lbl-1', label: 'NLP', color: '#8B5CF6', count: 2 },
    ]);
  });

  it('should build daily time-series creation and completion counts', () => {
    const from = new Date('2026-11-01T00:00:00.000Z');
    const to = new Date('2026-11-03T23:59:59.999Z');
    const series = buildWorkItemTimeSeries(
      [
        {
          createdAt: new Date('2026-11-01T10:00:00.000Z'),
          updatedAt: new Date('2026-11-02T14:00:00.000Z'),
          completed: true,
        },
      ],
      from,
      to,
    );

    expect(series).toEqual([
      { date: '2026-11-01', created: 1, completed: 0 },
      { date: '2026-11-02', created: 0, completed: 1 },
      { date: '2026-11-03', created: 0, completed: 0 },
    ]);
  });
});
