import { Injectable, NotFoundException } from '@nestjs/common';
import { isStateCompleted } from '@/modules/work-item/common/utils/state-completion.util';

export interface RankUpdateItem {
  id: string;
  rank: number;
  columnId: string;
  completed: boolean;
}

export const RANK_STEP = 1000;
export const MIN_RANK_PRECISION_GAP = 0.0001;

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
    let currentWorkItem = columnWorkItems.find(
      (item) => item.id === workItemId,
    );
    if (
      !currentWorkItem &&
      movingWorkItem &&
      movingWorkItem.id === workItemId
    ) {
      currentWorkItem = movingWorkItem;
    }

    if (!currentWorkItem) {
      throw new NotFoundException(`WorkItem with ID ${workItemId} not found`);
    }

    const otherWorkItems = columnWorkItems.filter(
      (item) => item.id !== workItemId,
    );
    const clampedRank = Math.max(
      0,
      Math.min(targetRank, otherWorkItems.length),
    );
    otherWorkItems.splice(clampedRank, 0, {
      ...currentWorkItem,
      columnId: targetColumn,
    });

    const isTargetDone = isDoneFn(targetColumn);
    const updates: RankUpdateItem[] = [];

    for (let index = 0; index < otherWorkItems.length; index++) {
      const item = otherWorkItems[index];
      const isMovedItem = item.id === workItemId;
      const rankChanged = item.rank !== index;
      const columnChanged = item.columnId !== targetColumn;

      if (isMovedItem || rankChanged || columnChanged) {
        updates.push({
          id: item.id,
          rank: index,
          columnId: targetColumn,
          completed: isTargetDone,
        });
      }
    }

    return updates;
  }

  /**
   * Computes a fractional rank between prevRank and nextRank.
   * Detects when the gap falls below MIN_RANK_PRECISION_GAP (0.0001), signaling that
   * rebalanceColumnRanks must be triggered.
   */
  computeMidpointRank(
    prevRank: number | null | undefined,
    nextRank: number | null | undefined,
  ): { rank: number; needsRebalance: boolean } {
    const hasPrev = typeof prevRank === 'number' && !isNaN(prevRank);
    const hasNext = typeof nextRank === 'number' && !isNaN(nextRank);

    if (!hasPrev && !hasNext) {
      return { rank: RANK_STEP, needsRebalance: false };
    }
    if (!hasPrev && hasNext) {
      const rank = nextRank > RANK_STEP ? nextRank - RANK_STEP : nextRank / 2;
      const gap = Math.abs(nextRank - rank);
      return { rank, needsRebalance: gap < MIN_RANK_PRECISION_GAP };
    }
    if (hasPrev && !hasNext) {
      return { rank: prevRank + RANK_STEP, needsRebalance: false };
    }

    const gap = Math.abs(nextRank! - prevRank!);
    const midpoint = (prevRank! + nextRank!) / 2;
    const minSubGap = Math.min(
      Math.abs(midpoint - prevRank!),
      Math.abs(nextRank! - midpoint),
    );
    return {
      rank: midpoint,
      needsRebalance:
        gap < MIN_RANK_PRECISION_GAP || minSubGap < MIN_RANK_PRECISION_GAP,
    };
  }

  /**
   * Rebalances all items in a column with uniform RANK_STEP (1000, 2000, 3000...) spacing
   * when fractional precision is exhausted.
   */
  rebalanceColumnRanks(
    columnWorkItems: Array<{ id: string; columnId: string; rank: number }>,
    targetColumn?: string,
    isDoneFn: (columnId?: string | null) => boolean = (columnId) =>
      isStateCompleted(columnId),
  ): RankUpdateItem[] {
    const sorted = [...columnWorkItems].sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.id.localeCompare(b.id);
    });

    return sorted.map((item, idx) => {
      const col = targetColumn || item.columnId;
      return {
        id: item.id,
        rank: (idx + 1) * RANK_STEP,
        columnId: col,
        completed: isDoneFn(col),
      };
    });
  }

  /**
   * Inserts or moves an item between prevRank and nextRank using fractional ranks,
   * automatically falling back to rebalanceColumnRanks if precision gap < 0.0001.
   */
  calculateFractionalReorder(
    columnWorkItems: Array<{ id: string; columnId: string; rank: number }>,
    workItemId: string,
    targetColumn: string,
    prevRank: number | null | undefined,
    nextRank: number | null | undefined,
    isDoneFn: (columnId?: string | null) => boolean = (columnId) =>
      isStateCompleted(columnId),
    movingWorkItem?: { id: string; columnId: string; rank: number },
  ): {
    rank: number;
    rebalanced: boolean;
    updates: RankUpdateItem[];
  } {
    let currentWorkItem = columnWorkItems.find(
      (item) => item.id === workItemId,
    );
    if (
      !currentWorkItem &&
      movingWorkItem &&
      movingWorkItem.id === workItemId
    ) {
      currentWorkItem = movingWorkItem;
    }
    if (!currentWorkItem) {
      throw new NotFoundException(`WorkItem with ID ${workItemId} not found`);
    }

    const { rank, needsRebalance } = this.computeMidpointRank(
      prevRank,
      nextRank,
    );
    const isTargetDone = isDoneFn(targetColumn);

    if (!needsRebalance) {
      return {
        rank,
        rebalanced: false,
        updates: [
          {
            id: workItemId,
            rank,
            columnId: targetColumn,
            completed: isTargetDone,
          },
        ],
      };
    }

    const otherItems = columnWorkItems.filter((item) => item.id !== workItemId);
    const combined = [
      ...otherItems,
      { id: workItemId, columnId: targetColumn, rank },
    ];
    const rebalancedUpdates = this.rebalanceColumnRanks(
      combined,
      targetColumn,
      isDoneFn,
    );
    const assigned =
      rebalancedUpdates.find((u) => u.id === workItemId)?.rank ?? rank;

    return {
      rank: assigned,
      rebalanced: true,
      updates: rebalancedUpdates,
    };
  }
}
