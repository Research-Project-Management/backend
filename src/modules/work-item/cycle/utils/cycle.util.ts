import { CycleStats, CycleTaskItem } from '../types/cycle.types';
import { inferStateGroup } from '../../state/utils/state.util';

export const calculateCycleStats = (
  tasks: Array<
    Partial<CycleTaskItem> & {
      columnId?: string;
      completed?: boolean;
    }
  >,
): CycleStats => {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const total = safeTasks.length;
  let completed = 0;
  let started = 0;
  let unstarted = 0;
  let backlog = 0;
  let cancelled = 0;

  for (const task of safeTasks) {
    const group = inferStateGroup(task.columnId, task.columnId);
    const isCompleted = task.completed === true || group === 'completed';

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
    totalTasks: total,
    completedTasks: completed,
    startedTasks: started,
    unstartedTasks: unstarted,
    backlogTasks: backlog,
    cancelledTasks: cancelled,
    completionPercentage: percentage,
  };
};
