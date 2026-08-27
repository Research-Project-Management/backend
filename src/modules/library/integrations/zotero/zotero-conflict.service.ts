import { Injectable, Logger } from '@nestjs/common';

export interface FieldConflict {
  field: string;
  baseValue: any;
  localValue: any;
  remoteValue: any;
}

export interface ThreeWayMergeResult {
  hasConflict: boolean;
  conflictType?:
    | 'none'
    | 'field_conflict'
    | 'local_delete_vs_remote_edit'
    | 'remote_delete_vs_local_edit';
  conflicts: FieldConflict[];
  mergedData: Record<string, any>;
  autoMergedFields: string[];
}

@Injectable()
export class ZoteroConflictService {
  private readonly logger = new Logger(ZoteroConflictService.name);

  /**
   * Executes a robust 3-way merge across base snapshot, local state, and remote state.
   */
  mergeItemThreeWay(
    base: Record<string, any> | null,
    local: Record<string, any>,
    remote: Record<string, any>,
  ): ThreeWayMergeResult {
    // 1. Check Delete vs Edit conflicts
    if (local.isDeleted && !remote.isDeleted && base && !base.isDeleted) {
      return {
        hasConflict: true,
        conflictType: 'local_delete_vs_remote_edit',
        conflicts: [],
        mergedData: {},
        autoMergedFields: [],
      };
    }

    if (!local.isDeleted && remote.isDeleted && base && !base.isDeleted) {
      return {
        hasConflict: true,
        conflictType: 'remote_delete_vs_local_edit',
        conflicts: [],
        mergedData: {},
        autoMergedFields: [],
      };
    }

    const baseObj = base || {};
    const mergedData: Record<string, any> = {};
    const conflicts: FieldConflict[] = [];
    const autoMergedFields: string[] = [];

    // Collect all field keys across base, local, and remote
    const allKeys = new Set([
      ...Object.keys(baseObj),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);

    const ignoredFields = new Set([
      'id',
      'key',
      'version',
      'remoteKey',
      'remoteVersion',
      'isDeleted',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ]);

    for (const key of allKeys) {
      if (ignoredFields.has(key)) {
        continue;
      }

      const baseVal = baseObj[key];
      const localVal = local[key];
      const remoteVal = remote[key];

      // Handle Tag / Collection list additive merge
      if (key === 'tags' || key === 'collections' || key === 'collectionKeys') {
        const mergedArray = this.mergeAdditiveList(
          baseVal,
          localVal,
          remoteVal,
        );
        mergedData[key] = mergedArray;
        autoMergedFields.push(key);
        continue;
      }

      const localChanged = !this.isEqual(baseVal, localVal);
      const remoteChanged = !this.isEqual(baseVal, remoteVal);

      if (!localChanged && !remoteChanged) {
        // Neither changed -> keep base
        if (baseVal !== undefined) mergedData[key] = baseVal;
      } else if (localChanged && !remoteChanged) {
        // Only local changed -> take local
        if (localVal !== undefined) mergedData[key] = localVal;
        autoMergedFields.push(key);
      } else if (!localChanged && remoteChanged) {
        // Only remote changed -> take remote
        if (remoteVal !== undefined) mergedData[key] = remoteVal;
        autoMergedFields.push(key);
      } else {
        // Both changed: check if they changed to the same value
        if (this.isEqual(localVal, remoteVal)) {
          if (localVal !== undefined) mergedData[key] = localVal;
          autoMergedFields.push(key);
        } else {
          // Conflict: distinct values on same field!
          conflicts.push({
            field: key,
            baseValue: baseVal,
            localValue: localVal,
            remoteValue: remoteVal,
          });
        }
      }
    }

    const hasConflict = conflicts.length > 0;

    return {
      hasConflict,
      conflictType: hasConflict ? 'field_conflict' : 'none',
      conflicts,
      mergedData,
      autoMergedFields,
    };
  }

  /**
   * Additively merges string / tag arrays without loss of additions.
   */
  private mergeAdditiveList(base: any, local: any, remote: any): string[] {
    const baseSet = new Set<string>(Array.isArray(base) ? base : []);
    const localSet = new Set<string>(Array.isArray(local) ? local : []);
    const remoteSet = new Set<string>(Array.isArray(remote) ? remote : []);

    const result = new Set<string>();

    // Include local items
    for (const item of localSet) {
      result.add(item);
    }

    // Include remote items
    for (const item of remoteSet) {
      result.add(item);
    }

    // Preserve items that weren't deleted
    for (const item of baseSet) {
      if (localSet.has(item) || remoteSet.has(item)) {
        result.add(item);
      }
    }

    return Array.from(result).sort();
  }

  private isEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
      return a === b;
    }
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }
}
