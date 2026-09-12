export interface StateBadge {
  id: string;
  name: string;
  color: string;
  group: string;
}

export interface StateTransitionItem {
  id: string;
  fromState: StateBadge;
  toState: StateBadge;
  actor?: {
    id: string;
    name: string;
    email: string | null;
    avatar: string | null;
  } | null;
  transitionedAt: Date;
  timeInStateMs: number;
  timeInStateBadge: string; // e.g., "54m", "1d 4h", "3d"
}

export interface WorkItemTransitionsResponse {
  taskId: string;
  currentState: StateBadge;
  currentDurationMs: number;
  currentDurationBadge: string;
  totalCycleTimeMs: number;
  totalCycleTimeBadge: string;
  completed: boolean;
  transitions: StateTransitionItem[];
}
