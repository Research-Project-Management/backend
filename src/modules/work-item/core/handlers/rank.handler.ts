import { Injectable } from '@nestjs/common';
import { isStateCompleted } from '../../state/utils/state.util';

export interface RankUpdateItem {
  id: string;
  rank: number;
  columnId: string;
  completed: boolean;
}

@Injectable()
export class RankHandler {
  calculateReorder(
    columnWorkItems: Array<{ id: string; columnId: string; rank: number }>,
    workItemId: string,
    targetColumn: string,
    targetRank: number,
    isDoneFn: (columnId?: string | null) => boolean = (columnId) =>
      isStateCompleted(columnId),
    movingWorkItem?: { id: string; columnId: string; rank: number },
  ): RankUpdateItem[] {
    let currentWorkItem = columnWorkItems.find((item) => item.id === workItemId);
    if (!currentWorkItem && movingWorkItem && movingWorkItem.id === workItemId) {
      currentWorkItem = movingWorkItem;
    }

    if (!currentWorkItem) {
      throw new Error(`WorkItem with ID ${workItemId} not found`);
    }

    const otherWorkItems = columnWorkItems.filter((item) => item.id !== workItemId);
    const clampedRank = Math.max(0, Math.min(targetRank, otherWorkItems.length));
    otherWorkItems.splice(clampedRank, 0, { ...currentWorkItem, columnId: targetColumn });

    return otherWorkItems.map((item, index) => ({
      id: item.id,
      rank: index,
      columnId: targetColumn,
      completed: isDoneFn(targetColumn),
    }));
  }
}

export const WorkItemRankHandler = RankHandler;
export type WorkItemRankHandler = RankHandler;
