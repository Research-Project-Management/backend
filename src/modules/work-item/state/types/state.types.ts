/**
 * Work Item State Domain Types & Interfaces
 *
 * Implements the standard 5 state groups (backlog, unstarted, started, completed, cancelled),
 * group-driven lifecycle progress, and safe task migration ports.
 */

export type StateGroup =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

export const STATE_GROUPS: readonly StateGroup[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
] as const;

export interface WorkItemState {
  id: string;
  name: string;
  color: string;
  group: StateGroup;
  description?: string;
  sequence: number;
  isDefault: boolean;
  // Backwards-compatibility aliases with existing Project.taskColumns schema
  title?: string;
  accentColor?: string;
}

export const DEFAULT_WORK_ITEM_STATES: WorkItemState[] = [
  {
    id: 'backlog',
    name: 'Backlog',
    title: 'Backlog',
    group: 'backlog',
    color: '#6366F1',
    accentColor: '#6366F1',
    sequence: 1000,
    isDefault: true,
    description: 'Items awaiting prioritization and scheduling',
  },
  {
    id: 'todo',
    name: 'To Do',
    title: 'To Do',
    group: 'unstarted',
    color: '#0EA5E9',
    accentColor: '#0EA5E9',
    sequence: 2000,
    isDefault: false,
    description: 'Items ready to be worked on in the current cycle',
  },
  {
    id: 'in_progress',
    name: 'In Progress',
    title: 'In Progress',
    group: 'started',
    color: '#F59E0B',
    accentColor: '#F59E0B',
    sequence: 3000,
    isDefault: false,
    description: 'Items actively being worked on by assignees',
  },
  {
    id: 'done',
    name: 'Done',
    title: 'Done',
    group: 'completed',
    color: '#22C55E',
    accentColor: '#22C55E',
    sequence: 4000,
    isDefault: false,
    description: 'Items completed and accepted',
  },
  {
    id: 'cancelled',
    name: 'Cancelled',
    title: 'Cancelled',
    group: 'cancelled',
    color: '#EF4444',
    accentColor: '#EF4444',
    sequence: 5000,
    isDefault: false,
    description: 'Items abandoned, duplicate, or rejected',
  },
];

export interface StateTaskCount {
  stateId: string;
  count: number;
}

export interface IStateRepository {
  findProjectStates(projectId: string): Promise<WorkItemState[]>;
  saveProjectStates(
    projectId: string,
    states: WorkItemState[],
  ): Promise<WorkItemState[]>;
  countTasksByState(projectId: string): Promise<Record<string, number>>;
  countTasksInState(projectId: string, stateId: string): Promise<number>;
  migrateTasksToState(
    projectId: string,
    fromStateId: string,
    toStateId: string,
    isToCompleted: boolean,
  ): Promise<number>;
  deleteStateWithTaskMigration(
    projectId: string,
    deletedStateId: string,
    fallbackStateId: string,
    updatedStates: WorkItemState[],
    isFallbackCompleted: boolean,
  ): Promise<void>;
}
