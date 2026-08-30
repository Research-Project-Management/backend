/**
 * Zotero Integration Domain & Operational Events Catalog.
 * Owned strictly by the Zotero bounded context.
 */

export const ZOTERO_EVENT_TYPES = {
  // Inbound Synchronization (Pull & Streaming)
  STREAM_RECEIVED: 'integration.zotero.stream_event_received',
  PULL_COMPLETED: 'integration.zotero.pull_completed',
  ITEM_SYNCED: 'integration.zotero.item_synced',
  COLLECTION_SYNCED: 'integration.zotero.collection_synced',
  ATTACHMENT_SYNCED: 'integration.zotero.attachment_synced',
  NOTE_SYNCED: 'integration.zotero.note_synced',
  ANNOTATION_SYNCED: 'integration.zotero.annotation_synced',

  // Outbound Synchronization (Push)
  PUSH_REQUESTED: 'integration.zotero.push_requested',
  PUSH_COMPLETED: 'integration.zotero.push_completed',
  ITEM_PUSHED: 'integration.zotero.item_pushed',
  ITEM_DELETED_PUSHED: 'integration.zotero.item_deleted_pushed',

  // Conflicts & Policy Management
  CONFLICT_DETECTED: 'integration.zotero.conflict_detected',
  CONFLICT_RESOLVED: 'integration.zotero.conflict_resolved',
  SYNC_DIRECTION_UPDATED: 'integration.zotero.sync_direction_updated',
  GLOBAL_KILL_SWITCH_TOGGLED: 'integration.zotero.global_kill_switch_toggled',
  WORKSPACE_KILL_SWITCH_TOGGLED:
    'integration.zotero.workspace_kill_switch_toggled',
} as const;

export type ZoteroEventType =
  (typeof ZOTERO_EVENT_TYPES)[keyof typeof ZOTERO_EVENT_TYPES];

export interface ZoteroStreamReceivedPayload {
  workspaceId: string;
  connectionId: string;
  remoteLibraryId: string;
  remoteLibraryType: 'user' | 'group';
  eventPayload: unknown;
}

export interface ZoteroPullCompletedPayload {
  workspaceId: string;
  bindingId: string;
  syncRunId: string;
  itemsCreated: number;
  itemsUpdated: number;
  collectionsCreated: number;
  versionAfter: string;
}

export interface ZoteroPushCompletedPayload {
  workspaceId: string;
  bindingId: string;
  syncRunId: string;
  itemsPushed: number;
  itemsDeleted: number;
}

export interface ZoteroConflictDetectedPayload {
  workspaceId: string;
  bindingId: string;
  entityId: string;
  remoteKey: string;
  reason: string;
}
