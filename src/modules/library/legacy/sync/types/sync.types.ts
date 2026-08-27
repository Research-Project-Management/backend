export type LibraryEntityType =
  'item' | 'collection' | 'tag' | 'attachment' | 'note' | 'annotation';

export type LibraryChangeAction = 'create' | 'update' | 'delete';

export interface LibraryChange {
  seq: number;
  workspaceId: string;
  entityType: LibraryEntityType;
  entityId: string;
  action: LibraryChangeAction;
  version: number;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface GetChangesResponse {
  changes: LibraryChange[];
  latestSeq: number;
  hasMore: boolean;
}

export interface SyncPushMutation {
  clientId?: string;
  entityType: LibraryEntityType;
  entityId: string;
  action: LibraryChangeAction;
  baseVersion: number;
  data?: Record<string, any>;
}

export interface SyncPushConflict {
  entityId: string;
  serverVersion: number;
  baseVersion: number;
  serverData?: Record<string, any>;
  message: string;
}

export interface SyncPushResult {
  applied: Array<{ entityId: string; newVersion: number; seq: number }>;
  conflicts: SyncPushConflict[];
}
