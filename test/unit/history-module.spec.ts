import { HistoryService } from '@/modules/work-item/history/history.service';
import { HistoryRepository } from '@/modules/work-item/history/history.repository';
import { NotFoundException } from '@nestjs/common';
import { CollaborationTab } from '@/modules/work-item/history/dto/feed-query.dto';

describe('History Module', () => {
  let service: HistoryService;
  let mockRepo: {
    findTaskWithProject: jest.Mock;
    findStateTransitions: jest.Mock;
    findHistoryEvents: jest.Mock;
    findTaskActivityEvents: jest.Mock;
    findTaskComments: jest.Mock;
    findTaskWorklogs: jest.Mock;
  };

  const taskId = 'task-1';

  beforeEach(() => {
    mockRepo = {
      findTaskWithProject: jest.fn(),
      findStateTransitions: jest.fn(),
      findHistoryEvents: jest.fn(),
      findTaskActivityEvents: jest.fn(),
      findTaskComments: jest.fn(),
      findTaskWorklogs: jest.fn().mockResolvedValue([]),
    };
    service = new HistoryService(mockRepo as unknown as HistoryRepository);
  });

  describe('getTransitions', () => {
    it('should throw NotFoundException if task not found', async () => {
      mockRepo.findTaskWithProject.mockResolvedValue(null);
      await expect(service.getTransitions(taskId)).rejects.toThrow(NotFoundException);
    });

    it('should calculate state transitions and durations', async () => {
      const createdAt = new Date(Date.now() - 100000);
      mockRepo.findTaskWithProject.mockResolvedValue({
        id: taskId,
        createdAt,
        columnId: 'done',
        completed: true,
        project: {
          taskColumns: [
            { id: 'todo', name: 'To Do', color: '#ccc' },
            { id: 'done', name: 'Done', color: '#0f0' },
          ],
        },
      });
      mockRepo.findStateTransitions.mockResolvedValue([
        {
          id: 'ev-1',
          oldValue: 'todo',
          newValue: 'done',
          createdAt: new Date(Date.now() - 50000),
          actor: { id: 'u-1', name: 'Alice' },
        },
      ]);

      const result = await service.getTransitions(taskId);
      expect(result.taskId).toBe(taskId);
      expect(result.completed).toBe(true);
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0].fromState.name).toBe('To Do');
      expect(result.transitions[0].toState.name).toBe('Done');
    });
  });

  describe('getHistory', () => {
    it('should return property changelog history', async () => {
      mockRepo.findHistoryEvents.mockResolvedValue([
        {
          id: 'h-1',
          field: 'priority',
          oldValue: 'low',
          newValue: 'urgent',
          createdAt: new Date(),
          actor: { id: 'u-1' },
        },
      ]);

      const result = await service.getHistory(taskId);
      expect(result.taskId).toBe(taskId);
      expect(result.total).toBe(1);
      expect(result.histories[0].field).toBe('priority');
    });
  });

  describe('getActivity', () => {
    it('should return activity events for task', async () => {
      mockRepo.findTaskActivityEvents.mockResolvedValue([
        { id: 'act-1', action: 'created', createdAt: new Date() },
      ]);

      const result = await service.getActivity(taskId);
      expect(result.taskId).toBe(taskId);
      expect(result.total).toBe(1);
    });
  });

  describe('getUnifiedFeed', () => {
    it('should return comments tab feed', async () => {
      mockRepo.findTaskComments.mockResolvedValue([
        { id: 'c-1', content: 'hello', createdAt: new Date(), user: { id: 'u-1' } },
      ]);

      const result = await service.getUnifiedFeed(taskId, { tab: CollaborationTab.COMMENTS });
      expect(result.tab).toBe(CollaborationTab.COMMENTS);
      expect(result.feed).toHaveLength(1);
      expect(result.feed[0].type).toBe('comment');
    });

    it('should return activity tab feed', async () => {
      mockRepo.findTaskActivityEvents.mockResolvedValue([
        { id: 'a-1', action: 'update', createdAt: new Date(), actor: { id: 'u-1' } },
      ]);

      const result = await service.getUnifiedFeed(taskId, { tab: CollaborationTab.ACTIVITY });
      expect(result.tab).toBe(CollaborationTab.ACTIVITY);
      expect(result.feed).toHaveLength(1);
      expect(result.feed[0].type).toBe('activity');
    });

    it('should return combined all tab feed', async () => {
      mockRepo.findTaskComments.mockResolvedValue([
        { id: 'c-1', content: 'comment', createdAt: new Date(), user: { id: 'u-1' } },
      ]);
      mockRepo.findTaskActivityEvents.mockResolvedValue([]);
      mockRepo.findTaskWorklogs.mockResolvedValue([]);

      const result = await service.getUnifiedFeed(taskId, { tab: CollaborationTab.ALL });
      expect(result.tab).toBe(CollaborationTab.ALL);
      expect(result.feed).toHaveLength(1);
    });
  });
});
