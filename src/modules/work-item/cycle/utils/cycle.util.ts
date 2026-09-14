import { CycleStats, CycleWorkItemItem } from '../types/cycle.types';
import { inferStateGroup } from '../../state/utils/state.util';

export const calculateCycleStats = (
  workItems: Array<
    Partial<CycleWorkItemItem> & {
      columnId?: string;
      completed?: boolean;
    }
  >,
): CycleStats => {
  const safeItems = Array.isArray(workItems) ? workItems : [];
  const total = safeItems.length;
  let completed = 0;
  let started = 0;
  let unstarted = 0;
  let backlog = 0;
  let cancelled = 0;

  for (const workItem of safeItems) {
    const group = inferStateGroup(workItem.columnId, workItem.columnId);
    const isCompleted = workItem.completed === true || group === 'completed';

    if (isCompleted) {
      completed++;
    } else if (group === 'cancelled') {
      cancelled++;
    } else if (group === 'started') {
      started++;
    } else if (group === 'backlog') {
      backlog++;
    } else {
      unstarted++;
    }
  }

  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    totalWorkItems: total,
    completedWorkItems: completed,
    startedWorkItems: started,
    unstartedWorkItems: unstarted,
    backlogWorkItems: backlog,
    cancelledWorkItems: cancelled,
    completionPercentage: percentage,
  };
};
