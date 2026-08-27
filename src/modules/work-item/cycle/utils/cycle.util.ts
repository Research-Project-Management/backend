import { CycleStats } from '../types/cycle.types';

export { CycleStats };

export const calculateCycleStats = (
  tasks: Array<{ columnId: string; completed?: boolean }>,
): CycleStats => {
  const total = tasks.length;
  const completed = tasks.filter(
    (taskItem) => taskItem.columnId === 'done' || taskItem.completed === true,
  ).length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  return {
    totalTasks: total,
    completedTasks: completed,
    completionPercentage: percentage,
  };
};
