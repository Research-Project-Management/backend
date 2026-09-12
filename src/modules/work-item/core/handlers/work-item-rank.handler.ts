import { Injectable } from '@nestjs/common';
import { isStateCompleted } from '../../state/utils/state.util';

export interface RankUpdateItem {
  id: string;
  rank: number;
  columnId: string;
  completed: boolean;
}

@Injectable()
export class WorkItemRankHandler {
  /**
   * Calculates new sequential ranks when moving a work item within or between columns.
   */
  calculateReorder(
    columnTasks: Array<{ id: string; columnId: string; rank: number }>,
    taskId: string,
    targetColumn: string,
    targetRank: number,
    isDoneFn: (columnId?: string | null) => boolean = (columnId) => isStateCompleted(columnId),
  ): RankUpdateItem[] {
    const currentTask = columnTasks.find((taskItem) => taskItem.id === taskId);
    const otherTasks = columnTasks.filter((taskItem) => taskItem.id !== taskId);

    if (currentTask) {
      otherTasks.splice(targetRank, 0, currentTask);
    }

    return otherTasks.map((taskItem, index) => ({
      id: taskItem.id,
      rank: index,
      columnId: targetColumn,
      completed: isDoneFn(targetColumn),
    }));
  }
}
