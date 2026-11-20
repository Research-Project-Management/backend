import type { RealtimeEventClass } from '../core/ws-rate-limiter';

export const PAGES_EVENTS = {
  // Space / Project-level lifecycle & broadcast events
  PROJECT_JOIN: 'project:join',
  PROJECT_LEAVE: 'project:leave',
  USER_JOINED_PROJECT: 'project:user-joined',
  USER_LEFT_PROJECT: 'project:user-left',

  // Document-level collaboration events
  DOC_JOIN: 'doc:join',
  DOC_LEAVE: 'doc:leave',
  USER_JOINED_DOC: 'doc:user-joined',
  USER_LEFT_DOC: 'doc:user-left',
  DOC_CURSOR: 'doc:cursor',
  DOC_EVICTED: 'doc:evicted',

  // Binary Yjs CRDT sync events
  YJS_SYNC_STEP_1: 'doc:sync:step1',
  YJS_SYNC_STEP_2: 'doc:sync:step2',
  YJS_SYNC_UPDATE: 'doc:sync:update',

  // Editor project chat events
  CHAT_SEND: 'project:chat:send',
  CHAT_NEW: 'project:chat:new',
  CHAT_HISTORY: 'project:chat:history',

  // External pages subsystem broadcast events
  FILE_TREE_UPDATE: 'fileTree:update',
  COMPILE_PROGRESS: 'compile:progress',
  HISTORY_NEW_VERSION: 'history:new-version',

  // Realtime access & revocation events
  ACCESS_REVOKED: 'access:revoked',
  ACCESS_UPDATED: 'access:updated',
} as const;

export const PAGES_ROOMS = {
  project: (spaceId: string): string => `project:${spaceId}`,
  doc: (spaceId: string, docId: string): string => `doc:${spaceId}:${docId}`,
} as const;

export const PAGES_REDIS_KEYS = {
  presence: (socketId: string): string => `manuscript:presence:${socketId}`,
  projectRoom: (spaceId: string): string =>
    `manuscript:project_rooms:${spaceId}`,
  docRoom: (spaceId: string, docId: string): string =>
    `manuscript:doc_rooms:${spaceId}:${docId}`,
  chatCache: (spaceId: string): string => `manuscript:chat:${spaceId}`,
} as const;

export const PAGES_RATE_CLASS_MAP: Readonly<
  Record<string, RealtimeEventClass>
> = Object.freeze({
  [PAGES_EVENTS.DOC_CURSOR]: 'cursor',
  [PAGES_EVENTS.YJS_SYNC_STEP_1]: 'update',
  [PAGES_EVENTS.YJS_SYNC_STEP_2]: 'update',
  [PAGES_EVENTS.YJS_SYNC_UPDATE]: 'update',
  [PAGES_EVENTS.CHAT_SEND]: 'chat',
  [PAGES_EVENTS.CHAT_HISTORY]: 'chat',
  [PAGES_EVENTS.PROJECT_JOIN]: 'joinLeave',
  [PAGES_EVENTS.PROJECT_LEAVE]: 'joinLeave',
  [PAGES_EVENTS.DOC_JOIN]: 'joinLeave',
  [PAGES_EVENTS.DOC_LEAVE]: 'joinLeave',
});

export function classifyPagesEvent(eventName: string): RealtimeEventClass {
  return PAGES_RATE_CLASS_MAP[eventName] ?? 'other';
}
