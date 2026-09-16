/**
 * Work Item State Domain Types & Interfaces
 *
 * Implements the standard 5 state groups (backlog, unstarted, started, completed, cancelled),
 * group-driven lifecycle progress, and safe WorkItem migration ports.
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
  icon?: string;
  group: StateGroup;
  description?: string;
  sequence: number;
  isDefault: boolean;
  // Project.workItemColumns schema
  title?: string;
  accentColor?: string;
}

export function getStateDefaultIcon(group: StateGroup): string {
  switch (group) {
    case 'backlog':
      return 'circle-dashed';
    case 'unstarted':
      return 'circle';
    case 'started':
      return 'circle-dot';
    case 'completed':
      return 'check-circle';
    case 'cancelled':
      return 'x-circle';
    default:
      return 'circle';
  }
}

export const DEFAULT_WORK_ITEM_STATES: WorkItemState[] = [
  {
    id: 'backlog',
    name: 'Backlog',
    title: 'Backlog',
    group: 'backlog',
    color: '#8A9093',
    accentColor: '#8A9093',
    icon: 'circle-dashed',
    sequence: 1000,
    isDefault: true,
    description: 'Items awaiting prioritization and scheduling',
  },
  {
    id: 'todo',
    name: 'Todo',
    title: 'Todo',
    group: 'unstarted',
    color: '#525866',
    accentColor: '#525866',
    icon: 'circle',
    sequence: 2000,
    isDefault: false,
    description: 'Items ready to be worked on in the current cycle',
  },
  {
    id: 'in_progress',
    name: 'In Progress',
    title: 'In Progress',
    group: 'started',
    color: '#EAB308',
    accentColor: '#EAB308',
    icon: 'circle-dot',
    sequence: 3000,
    isDefault: false,
    description: 'Items actively being worked on by assignees',
  },
  {
    id: 'done',
    name: 'Done',
    title: 'Done',
    group: 'completed',
    color: '#10B981',
    accentColor: '#10B981',
    icon: 'check-circle',
    sequence: 4000,
    isDefault: false,
    description: 'Items completed and accepted',
  },
  {
    id: 'cancelled',
    name: 'Cancelled',
    title: 'Cancelled',
    group: 'cancelled',
    color: '#8A9093',
    accentColor: '#8A9093',
    icon: 'x-circle',
    sequence: 5000,
    isDefault: false,
    description: 'Items abandoned, duplicate, or rejected',
  },
];

export interface StateWorkItemCount {
  stateId: string;
  count: number;
}

export interface IStateRepository {
  findProjectStates(projectId: string): Promise<WorkItemState[]>;
  saveProjectStates(
    projectId: string,
    states: WorkItemState[],
  ): Promise<WorkItemState[]>;
  countWorkItemsByState(projectId: string): Promise<Record<string, number>>;
  countWorkItemsInState(projectId: string, stateId: string): Promise<number>;
  migrateWorkItemsToState(
    projectId: string,
    fromStateId: string,
    toStateId: string,
    isToCompleted: boolean,
  ): Promise<number>;
  deleteStateWithWorkItemMigration(
    projectId: string,
    deletedStateId: string,
    fallbackStateId: string,
    updatedStates: WorkItemState[],
    isFallbackCompleted: boolean,
  ): Promise<void>;
}
