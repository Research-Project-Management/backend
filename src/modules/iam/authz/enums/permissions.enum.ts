export enum Permission {
  // Workspace Permissions
  WORKSPACE_VIEW = 'workspace:view',
  WORKSPACE_EDIT = 'workspace:edit',
  WORKSPACE_DELETE = 'workspace:delete',
  WORKSPACE_MANAGE_MEMBERS = 'workspace:manage_members',
  WORKSPACE_MANAGE_ROLES = 'workspace:manage_roles',

  // Project Permissions
  PROJECT_VIEW = 'project:view',
  PROJECT_CREATE = 'project:create',
  PROJECT_EDIT = 'project:edit',
  PROJECT_DELETE = 'project:delete',
  PROJECT_MANAGE_MEMBERS = 'project:manage_members',

  // Document & Manuscript Permissions
  DOCUMENT_VIEW = 'document:view',
  DOCUMENT_CREATE = 'document:create',
  DOCUMENT_EDIT = 'document:edit',
  DOCUMENT_DELETE = 'document:delete',
  DOCUMENT_COMMENT = 'document:comment',

  // Library & Asset Permissions
  LIBRARY_VIEW = 'library:view',
  LIBRARY_UPLOAD = 'library:upload',
  LIBRARY_DELETE = 'library:delete',
  LIBRARY_EXPORT = 'library:export',

  // Task & Planning Permissions
  TASK_VIEW = 'task:view',
  TASK_CREATE = 'task:create',
  TASK_EDIT = 'task:edit',
  TASK_DELETE = 'task:delete',
  TASK_ASSIGN = 'task:assign',

  // AI Agent Permissions
  AI_EXECUTE = 'ai:execute',
  AI_MANAGE_PROMPTS = 'ai:manage_prompts',
}
