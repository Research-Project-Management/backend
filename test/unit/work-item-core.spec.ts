import { IdHandler } from '@/modules/work-item/core/handlers/id.handler';
import { RankHandler } from '@/modules/work-item/core/handlers/rank.handler';
import { CloneHandler } from '@/modules/work-item/core/handlers/clone.handler';
import { EventDispatcher } from '@/modules/work-item/core/handlers/event.dispatcher';
import { WorkItemFacade } from '@/modules/work-item/work-item.facade';
import { TaskPriority } from '@prisma/client';

describe('Work Item Core Handlers & Facade', () => {
  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';

  describe('IdHandler', () => {
    let idHandler: IdHandler;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        project: {
          findFirst: jest.fn().mockResolvedValue({ identifier: 'RES', name: 'Research' }),
          findUnique: jest.fn().mockResolvedValue({ taskSequence: 10 }),
        },
        workItem: {
          findFirst: jest.fn().mockResolvedValue({ sequenceNumber: 4 }),
        },
      };
      idHandler = new IdHandler(mockPrisma);
    });

    it('should generate next identifier using highest sequence from tasks', async () => {
      const result = await idHandler.nextIdentifier(mockProjectId);
      expect(result.identifier).toBe('RES-5');
      expect(result.sequenceNumber).toBe(5);
    });

    it('should fall back to project taskSequence if no existing tasks', async () => {
      mockPrisma.workItem.findFirst.mockResolvedValueOnce(null);
      const result = await idHandler.nextIdentifier(mockProjectId);
      expect(result.identifier).toBe('RES-11');
      expect(result.sequenceNumber).toBe(11);
    });
  });

  describe('RankHandler', () => {
    let rankHandler: RankHandler;

    beforeEach(() => {
      rankHandler = new RankHandler();
    });

    it('should reorder WorkItem within column and assign sequential ranks', () => {
      const tasks = [
        { id: 't-1', columnId: 'todo', rank: 0 },
        { id: 't-2', columnId: 'todo', rank: 1 },
        { id: 't-3', columnId: 'todo', rank: 2 },
      ];

      // Move t-3 to index 0
      const result = rankHandler.calculateReorder(tasks, 't-3', 'todo', 0);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(expect.objectContaining({ id: 't-3', rank: 0, completed: false }));
      expect(result[1]).toEqual(expect.objectContaining({ id: 't-1', rank: 1, completed: false }));
      expect(result[2]).toEqual(expect.objectContaining({ id: 't-2', rank: 2, completed: false }));
    });

    it('should set completed true when target column is done', () => {
      const tasks = [{ id: 't-1', columnId: 'todo', rank: 0 }];
      const result = rankHandler.calculateReorder(
        tasks,
        't-1',
        'done',
        0,
        (col) => col === 'done',
      );
      expect(result[0].completed).toBe(true);
      expect(result[0].columnId).toBe('done');
    });

    it('should throw error if WorkItem to reorder is not found', () => {
      expect(() => {
        rankHandler.calculateReorder([], 'non-existent', 'todo', 0);
      }).toThrow('WorkItem with ID non-existent not found');
    });
  });

  describe('CloneHandler', () => {
    let cloneHandler: CloneHandler;
    let mockIdHandler: Partial<jest.Mocked<IdHandler>>;

    beforeEach(() => {
      mockIdHandler = {
        nextIdentifier: jest.fn().mockResolvedValue({
          identifier: 'PROJ-99',
          sequenceNumber: 99,
        }),
      };
      cloneHandler = new CloneHandler(mockIdHandler as unknown as IdHandler);
    });

    it('should build clone data with (Copy) suffix and new identifier', async () => {
      const sourceTask = {
        id: 'source-1',
        projectId: mockProjectId,
        title: 'Design Database Schema',
        content: 'Details here',
        columnId: 'todo',
        rank: 5,
        priority: TaskPriority.high,
        completed: false,
        assigneeId: mockUserId,
        cycleId: 'cycle-1',
        parentTaskId: null,
      };

      const result = await cloneHandler.buildCloneData(sourceTask, mockUserId);

      expect(result.identifier).toBe('PROJ-99');
      expect(result.cloneData.title).toBe('Design Database Schema (Copy)');
      expect(result.cloneData.rank).toBe(6);
      expect(result.cloneData.sequenceNumber).toBe(99);
      expect(result.cloneData.priority).toBe(TaskPriority.high);
      expect(result.isSameProject).toBe(true);
    });
  });

  describe('EventDispatcher', () => {
    let dispatcher: EventDispatcher;
    let mockEventEmitter: any;

    beforeEach(() => {
      mockEventEmitter = {
        emit: jest.fn(),
      };
      dispatcher = new EventDispatcher(mockEventEmitter);
    });

    it('should emit task.created event', () => {
      dispatcher.emitTaskCreated({
        taskId: 'task-1',
        actorId: mockUserId,
        projectId: mockProjectId,
        columnId: 'todo',
        title: 'New Task',
        identifier: 'PROJ-1',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({
          entityType: 'task',
          entityId: 'task-1',
          verb: 'created',
          projectId: mockProjectId,
        }),
      );
    });

    it('should dispatch specific field change events on update', () => {
      const existing = {
        id: 'task-1',
        projectId: mockProjectId,
        columnId: 'todo',
        priority: TaskPriority.low,
        title: 'Old Title',
        content: 'Old Content',
        cycleId: 'cycle-1',
      };

      dispatcher.dispatchUpdateEvents(
        existing,
        {
          columnId: 'done',
          priority: 'urgent',
          title: 'New Title',
          description: 'New Content',
          cycleId: 'cycle-2',
        },
        mockUserId,
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.state.changed',
        expect.objectContaining({ oldValue: 'todo', newValue: 'done' }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.priority.changed',
        expect.objectContaining({ oldValue: TaskPriority.low, newValue: TaskPriority.urgent }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.title.changed',
        expect.objectContaining({ oldValue: 'Old Title', newValue: 'New Title' }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.content.changed',
        expect.objectContaining({ oldValue: 'Old Content', newValue: 'New Content' }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.cycle.changed',
        expect.objectContaining({ oldValue: 'cycle-1', newValue: 'cycle-2' }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.updated',
        expect.objectContaining({ verb: 'updated' }),
      );
    });
  });

  describe('WorkItemFacade', () => {
    let facade: WorkItemFacade;
    let mockRepo: any;
    let mockStateService: any;

    const sampleWorkItem: any = {
      id: 'task-100',
      identifier: 'RESP-100',
      sequenceNumber: 100,
      title: 'Analyze Benchmark Results',
      columnId: 'in_progress',
      priority: TaskPriority.urgent,
      projectId: mockProjectId,
      authorId: mockUserId,
      assigneeId: mockUserId,
      cycleId: null,
      dueDate: null,
      completed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      mockRepo = {
        findTaskById: jest.fn().mockResolvedValue(sampleWorkItem),
        findProjectTasks: jest.fn().mockResolvedValue([sampleWorkItem]),
        findTasksByAssignee: jest.fn().mockResolvedValue([sampleWorkItem]),
        countProjectTasks: jest.fn().mockResolvedValue(42),
      };
      mockStateService = {
        getStates: jest.fn().mockResolvedValue({
          states: [{ id: 'in_progress', name: 'In Progress' }],
        }),
      };
      facade = new WorkItemFacade(mockRepo, mockStateService);
    });

    it('should map WorkItem to WorkItemSummary on getTaskById', async () => {
      const result = await facade.getTaskById('task-100');
      expect(result?.id).toBe('task-100');
      expect(result?.title).toBe('Analyze Benchmark Results');
      expect(result?.priority).toBe(TaskPriority.urgent);
    });

    it('should return null when getTaskById finds no task', async () => {
      mockRepo.findTaskById.mockResolvedValueOnce(null);
      const result = await facade.getTaskById('non-existent');
      expect(result).toBeNull();
    });

    it('should call findTasksByAssignee in getUserAssignedTasks', async () => {
      const results = await facade.getUserAssignedTasks(mockUserId);
      expect(mockRepo.findTasksByAssignee).toHaveBeenCalledWith(mockUserId, undefined);
      expect(results).toHaveLength(1);
      expect(results[0].assigneeId).toBe(mockUserId);
    });

    it('should filter by projectId in getUserAssignedTasks when provided', async () => {
      await facade.getUserAssignedTasks(mockUserId, mockProjectId);
      expect(mockRepo.findTasksByAssignee).toHaveBeenCalledWith(mockUserId, mockProjectId);
    });

    it('should return count of project tasks', async () => {
      const count = await facade.countTasksByProject(mockProjectId);
      expect(count).toBe(42);
    });

    it('should retrieve project states via StateService', async () => {
      const states = await facade.getProjectStates(mockProjectId);
      expect(states).toHaveLength(1);
      expect(states[0].name).toBe('In Progress');
    });
  });
});
