export enum Permission {
  // Workspace permissions
  WORKSPACE_READ = 'workspace:read',
  WORKSPACE_UPDATE = 'workspace:update',
  WORKSPACE_DELETE = 'workspace:delete',
  WORKSPACE_INVITE = 'workspace:invite_member',
  WORKSPACE_REMOVE_MEMBER = 'workspace:remove_member',
  WORKSPACE_UPDATE_ROLE = 'workspace:update_role',

  // Project permissions
  PROJECT_READ = 'project:read',
  PROJECT_CREATE = 'project:create',
  PROJECT_UPDATE = 'project:update',
  PROJECT_DELETE = 'project:delete',
  PROJECT_MANAGE_MEMBERS = 'project:manage_members',

  // Task & Planning permissions
  TASK_READ = 'task:read',
  TASK_CREATE = 'task:create',
  TASK_UPDATE = 'task:update',
  TASK_DELETE = 'task:delete',
  CYCLE_READ = 'cycle:read',
  CYCLE_MANAGE = 'cycle:manage',

  // Manuscript / Document / Page permissions
  DOCUMENT_READ = 'document:read',
  DOCUMENT_CREATE = 'document:create',
  DOCUMENT_EDIT = 'document:edit',
  DOCUMENT_DELETE = 'document:delete',
  DOCUMENT_COMPILE = 'document:compile',

  // Comment permissions
  COMMENT_READ = 'comment:read',
  COMMENT_CREATE = 'comment:create',
  COMMENT_DELETE = 'comment:delete',

  // Label permissions
  LABEL_READ = 'label:read',
  LABEL_MANAGE = 'label:manage',

  // Sticky permissions
  STICKY_READ = 'sticky:read',
  STICKY_CREATE = 'sticky:create',
  STICKY_UPDATE = 'sticky:update',
  STICKY_DELETE = 'sticky:delete',

  // Storage / File permissions
  FILE_READ = 'file:read',
  FILE_UPLOAD = 'file:upload',
  FILE_DELETE = 'file:delete',

  // Library / Paper permissions
  PAPER_READ = 'paper:read',
  PAPER_INGEST = 'paper:ingest',
  PAPER_DELETE = 'paper:delete',

  // Analytics permissions
  ANALYTICS_READ = 'analytics:read',
}
