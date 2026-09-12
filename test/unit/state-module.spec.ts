import {
  inferStateGroup,
  parseWorkItemStates,
  isStateCompleted,
  generateStateSlug,
} from '@/modules/work-item/state/utils/state.util';
import {
  DEFAULT_WORK_ITEM_STATES,
  WorkItemState,
} from '@/modules/work-item/state/types/state.types';
import { StateService } from '@/modules/work-item/state/state.service';
import { StateRepository } from '@/modules/work-item/state/state.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('Work Item State Module', () => {
  describe('state.util', () => {
    it('should infer correct state groups from legacy names and IDs', () => {
      expect(inferStateGroup('backlog', 'Backlog')).toBe('backlog');
      expect(inferStateGroup('todo', 'To Do')).toBe('unstarted');
      expect(inferStateGroup('in-progress', 'In Progress')).toBe('started');
      expect(inferStateGroup('review', 'Code Review')).toBe('started');
      expect(inferStateGroup('done', 'Done')).toBe('completed');
      expect(inferStateGroup('complete', 'Completed')).toBe('completed');
      expect(inferStateGroup('cancelled', 'Cancelled')).toBe('cancelled');
      expect(inferStateGroup('wontfix', 'Wont Fix')).toBe('cancelled');
      expect(inferStateGroup('custom', 'Something Else')).toBe('unstarted');
    });

    it('should accurately identify completed states according to group rule', () => {
      expect(isStateCompleted('completed')).toBe(true);
      expect(isStateCompleted('started')).toBe(false);
      expect(isStateCompleted('unstarted')).toBe(false);

      const completedState: WorkItemState = {
        id: 'done-1',
        name: 'Ready for Release',
        group: 'completed',
        color: '#22C55E',
        sequence: 4000,
        isDefault: false,
      };
      expect(isStateCompleted(completedState)).toBe(true);

      const inProgressState: WorkItemState = {
        id: 'doing',
        name: 'In Progress',
        group: 'started',
        color: '#F59E0B',
        sequence: 2000,
        isDefault: false,
      };
      expect(isStateCompleted(inProgressState)).toBe(false);
    });

    it('should generate URL-safe slugs for state IDs', () => {
      expect(generateStateSlug('In Progress')).toBe('in-progress');
      expect(generateStateSlug('  Code Review & QA! ')).toBe('code-review-qa');
    });

    it('should parse and normalize raw Project taskColumns JSON into domain states', () => {
      const raw = [
        {
          id: 'backlog',
          title: 'Backlog',
          isDefault: true,
          accentColor: '#6366F1',
        },
        {
          id: 'todo',
          title: 'To Do',
          isDefault: false,
          accentColor: '#0EA5E9',
        },
        {
          id: 'doing',
          title: 'In Progress',
          isDefault: false,
          accentColor: '#F59E0B',
        },
        { id: 'done', title: 'Done', isDefault: false, accentColor: '#22C55E' },
      ];

      const states = parseWorkItemStates(raw);
      expect(states).toHaveLength(4);
      expect(states[0].group).toBe('backlog');
      expect(states[0].name).toBe('Backlog');
      expect(states[0].isDefault).toBe(true);
      expect(states[1].group).toBe('unstarted');
      expect(states[2].group).toBe('started');
      expect(states[3].group).toBe('completed');
    });

    it('should return default states when input is empty or null', () => {
      const emptyResult = parseWorkItemStates([]);
      expect(emptyResult).toEqual(DEFAULT_WORK_ITEM_STATES);

      const nullResult = parseWorkItemStates(null);
      expect(nullResult).toEqual(DEFAULT_WORK_ITEM_STATES);
    });
  });

  describe('StateService domain rules', () => {
    let service: StateService;
    let mockRepo: jest.Mocked<StateRepository>;

    const testProject = {
      id: 'proj-1',
      workspaceId: 'ws-1',
      name: 'Project Alpha',
      taskColumns: [
        {
          id: 'backlog',
          name: 'Backlog',
          group: 'backlog',
          color: '#6366F1',
          sequence: 1000,
          isDefault: true,
        },
        {
          id: 'todo',
          name: 'To Do',
          group: 'unstarted',
          color: '#0EA5E9',
          sequence: 2000,
          isDefault: false,
        },
        {
          id: 'doing',
          name: 'Doing',
          group: 'started',
          color: '#F59E0B',
          sequence: 3000,
          isDefault: false,
        },
        {
          id: 'done',
          name: 'Done',
          group: 'completed',
          color: '#22C55E',
          sequence: 4000,
          isDefault: false,
        },
      ],
    };

    beforeEach(() => {
      mockRepo = {
        findProjectById: jest.fn().mockResolvedValue(testProject),
        findProjectStates: jest
          .fn()
          .mockResolvedValue(parseWorkItemStates(testProject.taskColumns)),
        saveProjectStates: jest
          .fn()
          .mockImplementation((_, states) => Promise.resolve(states)),
        countTasksByState: jest.fn().mockResolvedValue({ doing: 3, todo: 1 }),
        countTasksInState: jest.fn().mockImplementation((_, stateId) => {
          if (stateId === 'doing') return Promise.resolve(3);
          if (stateId === 'todo') return Promise.resolve(1);
          return Promise.resolve(0);
        }),
        migrateTasksToState: jest.fn().mockResolvedValue(3),
        deleteStateWithTaskMigration: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<StateRepository>;

      service = new StateService(mockRepo);
    });

    it('should throw NotFoundException if project not found on getStates', async () => {
      mockRepo.findProjectById.mockResolvedValueOnce(null);
      await expect(service.getStates('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject state creation if name is a duplicate', async () => {
      await expect(
        service.createState('proj-1', {
          name: 'Doing',
          group: 'started',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create new state and maintain sequence ordering', async () => {
      const result = await service.createState('proj-1', {
        name: 'In Review',
        group: 'started',
        color: '#8B5CF6',
      });

      expect(result.state.name).toBe('In Review');
      expect(result.state.group).toBe('started');
      expect(result.state.sequence).toBeGreaterThan(4000);
      expect(mockRepo.saveProjectStates).toHaveBeenCalled();
    });

    it('should prevent unsetting default state directly', async () => {
      await expect(
        service.updateState('proj-1', 'backlog', {
          isDefault: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should set new default state and unset the previous default', async () => {
      const result = await service.updateState('proj-1', 'todo', {
        isDefault: true,
      });

      expect(result.state.isDefault).toBe(true);
      const backlogState = result.states.find((s) => s.id === 'backlog');
      expect(backlogState?.isDefault).toBe(false);
    });

    it('should prevent deleting the default state', async () => {
      await expect(service.deleteState('proj-1', 'backlog')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should prevent deleting a state with active tasks if no fallback target state is provided', async () => {
      await expect(service.deleteState('proj-1', 'doing')).rejects.toThrow(
        /active work item\(s\)/,
      );
    });

    it('should successfully delete state and migrate tasks when fallback target state is provided', async () => {
      const result = await service.deleteState('proj-1', 'doing', 'todo');
      expect(mockRepo.deleteStateWithTaskMigration).toHaveBeenCalledWith(
        'proj-1',
        'doing',
        'todo',
        expect.any(Array),
        false, // todo is unstarted, not completed
      );
      expect(result.states.some((s) => s.id === 'doing')).toBe(false);
      expect(result.migratedTo).toBe('todo');
    });

    it('should reset states to 5 default preset states', async () => {
      const result = await service.resetToDefaultStates('proj-1');
      expect(result.states).toHaveLength(5);
      expect(result.states.map((s) => s.id)).toEqual([
        'backlog',
        'todo',
        'in_progress',
        'done',
        'cancelled',
      ]);
    });
  });
});
