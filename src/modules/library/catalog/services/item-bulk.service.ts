import { Injectable, Logger } from '@nestjs/common';

export interface IItemBulkOperationsTarget {
  deleteItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    context?: unknown,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean>;

  restoreItem(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<unknown>;

  purgeItem(
    userId: string,
    id: string,
    projectId?: string,
    skipScopeInvalidation?: boolean,
  ): Promise<boolean>;

  invalidateScopeCachesOnce(userId: string, projectId?: string): Promise<void>;
}

@Injectable()
export class ItemBulkService {
  private readonly logger = new Logger(ItemBulkService.name);

  async bulkTrash(
    target: IItemBulkOperationsTarget,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; trashedIds: string[] }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, trashedIds: [] };
    }
    const trashedIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const deleted = await target.deleteItem(
          userId,
          itemId,
          undefined,
          undefined,
          projectId,
          true,
        );
        if (deleted) trashedIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to move item ${itemId} to trash: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (trashedIds.length > 0) {
      await target.invalidateScopeCachesOnce(userId, projectId);
    }
    return { success: true, count: trashedIds.length, trashedIds };
  }

  async bulkRestore(
    target: IItemBulkOperationsTarget,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; restoredIds: string[] }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, restoredIds: [] };
    }
    const restoredIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        await target.restoreItem(userId, itemId, undefined, projectId, true);
        restoredIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to restore item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (restoredIds.length > 0) {
      await target.invalidateScopeCachesOnce(userId, projectId);
    }
    return { success: true, count: restoredIds.length, restoredIds };
  }

  async bulkPurge(
    target: IItemBulkOperationsTarget,
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ success: boolean; count: number; purgedIds: string[] }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, purgedIds: [] };
    }
    const purgedIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const purged = await target.purgeItem(userId, itemId, projectId, true);
        if (purged) purgedIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to purge item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (purgedIds.length > 0) {
      await target.invalidateScopeCachesOnce(userId, projectId);
    }
    return { success: true, count: purgedIds.length, purgedIds };
  }
}
