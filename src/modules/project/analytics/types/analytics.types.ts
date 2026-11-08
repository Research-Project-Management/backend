/**
 * Project Analytics Domain Types & Interfaces
 */

export interface AssigneeDistributionItem {
  userId: string;
  name: string;
  avatar: string | null;
  count: number;
  completedCount: number;
  inProgressCount: number;
  overdueCount: number;
}

export interface StateColumnBreakdownItem {
  id: string;
  name: string;
  group: string;
  color: string;
  count: number;
}

export interface LabelDistributionItem {
  id?: string;
  label: string;
  color?: string;
  count: number;
}

export interface TimeSeriesPoint {
  date: string;
  created: number;
  completed: number;
}

export interface ProjectDistributionResult {
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  overdueItems: number;
  unassignedItems: number;
  completionRate: number;
  state: Record<string, number>;
  stateGroups: Record<string, number>;
  states: StateColumnBreakdownItem[];
  priority: Record<string, number>;
  assignee: AssigneeDistributionItem[];
  labels: LabelDistributionItem[];
}

export interface RawAnalyticsWorkItem {
  id?: string;
  columnId?: string | null;
  stateId?: string | null;
  stateGroup?: string | null;
  stateName?: string | null;
  stateColor?: string | null;
  priority?: string | null;
  completed?: boolean;
  dueDate?: Date | string | null;
  assigneeId?: string | null;
  assignee?: {
    id?: string;
    name?: string | null;
    avatar?: string | null;
  } | null;
  labelAssignments?: Array<{
    label?: {
      id?: string;
      name?: string | null;
      color?: string | null;
    } | null;
  }>;
}

export interface RawProjectStateColumn {
  id: string;
  name: string;
  group: string;
  color: string;
  sequence?: number;
}
