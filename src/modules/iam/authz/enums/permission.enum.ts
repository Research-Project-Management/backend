/**
 * Granular Domain Permissions
 * Evaluated at the Project level across academic functional domains:
 * Project, WorkItem, Document, Library, Comment, File, Sticky, and AI Assistant.
 */
export enum Permission {
  // ─── 1. Project Management ──────────────────────────────────────────────────
  PROJECT_VIEW = 'project:view',
  PROJECT_READ = 'project:read', // Canonical alias for view
  PROJECT_CREATE = 'project:create',
  PROJECT_UPDATE = 'project:update',
  PROJECT_EDIT = 'project:edit', // Canonical alias for update
  PROJECT_DELETE = 'project:delete',
  PROJECT_MANAGE_SETTINGS = 'project:manage_settings',
  PROJECT_MANAGE_MEMBERS = 'project:manage_members',

  // ─── 2. Work Items & Tasks ──────────────────────────────────────────────────
  TASK_VIEW = 'WorkItem:view',
  TASK_READ = 'WorkItem:read',
  TASK_CREATE = 'WorkItem:create',
  TASK_UPDATE = 'WorkItem:update',
  TASK_EDIT = 'WorkItem:edit',
  TASK_DELETE = 'WorkItem:delete',
  TASK_ASSIGN = 'WorkItem:assign',
  TASK_CHANGE_STATE = 'WorkItem:change_state',
  TASK_MANAGE_LABELS = 'WorkItem:manage_labels',
  TASK_MANAGE_CYCLES = 'WorkItem:manage_cycles',

  // ─── 3. Documents & Manuscripts (LaTeX) ────────────────────────────────────
  DOCUMENT_VIEW = 'document:view',
  DOCUMENT_READ = 'document:read',
  DOCUMENT_CREATE = 'document:create',
  DOCUMENT_UPDATE = 'document:update',
  DOCUMENT_EDIT = 'document:edit',
  DOCUMENT_DELETE = 'document:delete',
  DOCUMENT_COMPILE = 'document:compile',
  DOCUMENT_COMMENT = 'document:comment',

  // ─── 4. Academic Library & Literature ──────────────────────────────────────
  LIBRARY_VIEW = 'library:view',
  LIBRARY_READ = 'library:read',
  LIBRARY_UPLOAD = 'library:upload',
  LIBRARY_UPDATE = 'library:update',
  LIBRARY_DELETE = 'library:delete',
  LIBRARY_ANNOTATE = 'library:annotate',
  LIBRARY_EXPORT = 'library:export',
  LIBRARY_SYNC = 'library:sync',

  // ─── 5. Comments & Peer Review ─────────────────────────────────────────────
  COMMENT_VIEW = 'comment:view',
  COMMENT_READ = 'comment:read',
  COMMENT_CREATE = 'comment:create',
  COMMENT_UPDATE_OWN = 'comment:update_own',
  COMMENT_DELETE_OWN = 'comment:delete_own',
  COMMENT_DELETE_ANY = 'comment:delete_any',
  COMMENT_DELETE = 'comment:delete', // Generic alias

  // ─── 6. Storage & Research Assets ──────────────────────────────────────────
  FILE_VIEW = 'file:view',
  FILE_READ = 'file:read',
  FILE_UPLOAD = 'file:upload',
  FILE_DOWNLOAD = 'file:download',
  FILE_DELETE = 'file:delete',

  // ─── 7. Stickies & Brainstorming Canvas ─────────────────────────────────────
  STICKY_VIEW = 'sticky:view',
  STICKY_READ = 'sticky:read',
  STICKY_CREATE = 'sticky:create',
  STICKY_UPDATE = 'sticky:update',
  STICKY_DELETE = 'sticky:delete',

  // ─── 8. AI Research Assistant ──────────────────────────────────────────────
  AI_EXECUTE = 'ai:execute',
  AI_RAG_SEARCH = 'ai:rag_search',
  AI_MANAGE_PROMPTS = 'ai:manage_prompts',
}
