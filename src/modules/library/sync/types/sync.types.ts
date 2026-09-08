export * from '../../common/types/sync.types';

export type SyncDirection = 'pull' | 'push' | 'reconcile';
export type SyncStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SyncSessionResult {
  bindingId: string;
  workspaceId: string;
  direction: SyncDirection;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeleted: number;
  status: SyncStatus;
  errorMessage?: string | null;
}
