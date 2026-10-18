export const REALTIME_NAMESPACES = {
  MANUSCRIPTS: '/manuscripts',
  NOTIFICATIONS: '/notifications',
} as const;

export const REALTIME_EVENTS = {
  // Project-level events
  PROJECT_JOIN: 'project:join',
  PROJECT_LEAVE: 'project:leave',
  USER_JOINED_PROJECT: 'project:user-joined',
  USER_LEFT_PROJECT: 'project:user-left',

  // Document-level events
  DOC_JOIN: 'doc:join',
  DOC_LEAVE: 'doc:leave',
  USER_JOINED_DOC: 'doc:user-joined',
  USER_LEFT_DOC: 'doc:user-left',
  DOC_UPDATE: 'doc:update',
  DOC_UPDATE_ACK: 'doc:update-ack',
  DOC_CURSOR: 'doc:cursor',

  // Binary Yjs sync events
  YJS_SYNC_STEP_1: 'doc:sync:step1',
  YJS_SYNC_STEP_2: 'doc:sync:step2',
  YJS_SYNC_UPDATE: 'doc:sync:update',

  // Chat events
  CHAT_SEND: 'project:chat:send',
  CHAT_NEW: 'project:chat:new',
  CHAT_HISTORY: 'project:chat:history',

  // External subsystem broadcast events
  FILE_TREE_UPDATE: 'fileTree:update',
  COMPILE_PROGRESS: 'compile:progress',
  HISTORY_NEW_VERSION: 'history:new-version',
} as const;

export const REDIS_KEYS = {
  presence: (socketId: string) => `manuscript:presence:${socketId}`,
  projectRoom: (projectId: string) => `manuscript:project_rooms:${projectId}`,
  docRoom: (projectId: string, docId: string) =>
    `manuscript:doc_rooms:${projectId}:${docId}`,
  yjsDoc: (projectId: string, docId: string) => `yjs:doc:${projectId}:${docId}`,
} as const;
