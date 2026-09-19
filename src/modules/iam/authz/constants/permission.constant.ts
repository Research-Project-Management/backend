import { Permission } from '../enums/permission.enum';
import { Role } from '../enums/role.enum';

/**
 * Role-to-Permission Mapping Matrix
 * Mapped strictly across 4 project-level canonical roles:
 * - OWNER: Project Leader / Principal Investigator (full administrative, personnel & asset authority)
 * - COORDINATOR: Project Coordinator (work management, cycles, triage; no personnel authority)
 * - CONTRIBUTOR: Research Member (active research, work items, manuscripts, literature uploads)
 * - REVIEWER: Advisor / Peer Reviewer (read-only with annotations, comments, and suggestions)
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // ─── 1. OWNER (Chủ nhiệm đề tài / Project Leader / PI) ────────────────────
  [Role.OWNER]: [
    // Project Management (Full Control & Exclusive Personnel Authority)
    Permission.PROJECT_VIEW,
    Permission.PROJECT_READ,
    Permission.PROJECT_CREATE,
    Permission.PROJECT_UPDATE,
    Permission.PROJECT_EDIT,
    Permission.PROJECT_DELETE,
    Permission.PROJECT_MANAGE_SETTINGS,
    Permission.PROJECT_MANAGE_MEMBERS,

    // Work Items & Cycles
    Permission.WORK_ITEM_VIEW,
    Permission.WORK_ITEM_READ,
    Permission.WORK_ITEM_CREATE,
    Permission.WORK_ITEM_UPDATE,
    Permission.WORK_ITEM_EDIT,
    Permission.WORK_ITEM_DELETE,
    Permission.WORK_ITEM_ASSIGN,
    Permission.WORK_ITEM_CHANGE_STATE,
    Permission.WORK_ITEM_MANAGE_LABELS,
    Permission.WORK_ITEM_MANAGE_CYCLES,

    // Manuscripts & LaTeX Documents
    Permission.DOCUMENT_VIEW,
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_CREATE,
    Permission.DOCUMENT_UPDATE,
    Permission.DOCUMENT_EDIT,
    Permission.DOCUMENT_DELETE,
    Permission.DOCUMENT_COMPILE,
    Permission.DOCUMENT_COMMENT,

    // Academic Library & Literature
    Permission.LIBRARY_VIEW,
    Permission.LIBRARY_READ,
    Permission.LIBRARY_UPLOAD,
    Permission.LIBRARY_UPDATE,
    Permission.LIBRARY_DELETE,
    Permission.LIBRARY_ANNOTATE,
    Permission.LIBRARY_EXPORT,
    Permission.LIBRARY_SYNC,

    // Comments & Review
    Permission.COMMENT_VIEW,
    Permission.COMMENT_READ,
    Permission.COMMENT_CREATE,
    Permission.COMMENT_UPDATE_OWN,
    Permission.COMMENT_DELETE_OWN,
    Permission.COMMENT_DELETE_ANY,
    Permission.COMMENT_DELETE,

    // Storage & Research Datasets
    Permission.FILE_VIEW,
    Permission.FILE_READ,
    Permission.FILE_UPLOAD,
    Permission.FILE_DOWNLOAD,
    Permission.FILE_DELETE,

    // Brainstorming Stickies
    Permission.STICKY_VIEW,
    Permission.STICKY_READ,
    Permission.STICKY_CREATE,
    Permission.STICKY_UPDATE,
    Permission.STICKY_DELETE,

    // AI Research Assistant
    Permission.AI_EXECUTE,
    Permission.AI_RAG_SEARCH,
    Permission.AI_MANAGE_PROMPTS,
  ],

  // ─── 2. COORDINATOR (Điều phối viên đề tài / Project Coordinator) ─────────
  [Role.COORDINATOR]: [
    // Project Management (Read-only on project, NO personnel management)
    Permission.PROJECT_VIEW,
    Permission.PROJECT_READ,

    // Work Items & Cycles (Full Work Management & Cycle Coordination)
    Permission.WORK_ITEM_VIEW,
    Permission.WORK_ITEM_READ,
    Permission.WORK_ITEM_CREATE,
    Permission.WORK_ITEM_UPDATE,
    Permission.WORK_ITEM_EDIT,
    Permission.WORK_ITEM_DELETE,
    Permission.WORK_ITEM_ASSIGN,
    Permission.WORK_ITEM_CHANGE_STATE,
    Permission.WORK_ITEM_MANAGE_LABELS,
    Permission.WORK_ITEM_MANAGE_CYCLES,

    // Manuscripts & LaTeX Documents (Full authoring & review)
    Permission.DOCUMENT_VIEW,
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_CREATE,
    Permission.DOCUMENT_UPDATE,
    Permission.DOCUMENT_EDIT,
    Permission.DOCUMENT_COMPILE,
    Permission.DOCUMENT_COMMENT,

    // Academic Library & Literature (Upload papers, curate, annotate, export)
    Permission.LIBRARY_VIEW,
    Permission.LIBRARY_READ,
    Permission.LIBRARY_UPLOAD,
    Permission.LIBRARY_UPDATE,
    Permission.LIBRARY_ANNOTATE,
    Permission.LIBRARY_EXPORT,
    Permission.LIBRARY_SYNC,

    // Comments & Review
    Permission.COMMENT_VIEW,
    Permission.COMMENT_READ,
    Permission.COMMENT_CREATE,
    Permission.COMMENT_UPDATE_OWN,
    Permission.COMMENT_DELETE_OWN,
    Permission.COMMENT_DELETE,

    // Storage & Research Datasets (Upload & download)
    Permission.FILE_VIEW,
    Permission.FILE_READ,
    Permission.FILE_UPLOAD,
    Permission.FILE_DOWNLOAD,

    // Brainstorming Stickies
    Permission.STICKY_VIEW,
    Permission.STICKY_READ,
    Permission.STICKY_CREATE,
    Permission.STICKY_UPDATE,
    Permission.STICKY_DELETE,

    // AI Research Assistant
    Permission.AI_EXECUTE,
    Permission.AI_RAG_SEARCH,
    Permission.AI_MANAGE_PROMPTS,
  ],

  // ─── 3. CONTRIBUTOR (Thành viên nghiên cứu / Contributor) ─────────────────
  [Role.CONTRIBUTOR]: [
    // Project Management (Read-only)
    Permission.PROJECT_VIEW,
    Permission.PROJECT_READ,

    // Work Items (Create, edit, assign, progress; NO Cycle management)
    Permission.WORK_ITEM_VIEW,
    Permission.WORK_ITEM_READ,
    Permission.WORK_ITEM_CREATE,
    Permission.WORK_ITEM_UPDATE,
    Permission.WORK_ITEM_EDIT,
    Permission.WORK_ITEM_DELETE,
    Permission.WORK_ITEM_ASSIGN,
    Permission.WORK_ITEM_CHANGE_STATE,
    Permission.WORK_ITEM_MANAGE_LABELS,

    // Manuscripts & LaTeX Documents (Full authoring)
    Permission.DOCUMENT_VIEW,
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_CREATE,
    Permission.DOCUMENT_UPDATE,
    Permission.DOCUMENT_EDIT,
    Permission.DOCUMENT_COMPILE,
    Permission.DOCUMENT_COMMENT,

    // Academic Library & Literature (Upload papers, annotate, sync)
    Permission.LIBRARY_VIEW,
    Permission.LIBRARY_READ,
    Permission.LIBRARY_UPLOAD,
    Permission.LIBRARY_UPDATE,
    Permission.LIBRARY_ANNOTATE,
    Permission.LIBRARY_EXPORT,
    Permission.LIBRARY_SYNC,

    // Comments & Review
    Permission.COMMENT_VIEW,
    Permission.COMMENT_READ,
    Permission.COMMENT_CREATE,
    Permission.COMMENT_UPDATE_OWN,
    Permission.COMMENT_DELETE_OWN,
    Permission.COMMENT_DELETE,

    // Storage & Research Datasets (Upload & download)
    Permission.FILE_VIEW,
    Permission.FILE_READ,
    Permission.FILE_UPLOAD,
    Permission.FILE_DOWNLOAD,

    // Brainstorming Stickies
    Permission.STICKY_VIEW,
    Permission.STICKY_READ,
    Permission.STICKY_CREATE,
    Permission.STICKY_UPDATE,
    Permission.STICKY_DELETE,

    // AI Research Assistant
    Permission.AI_EXECUTE,
    Permission.AI_RAG_SEARCH,
  ],

  // ─── 4. REVIEWER (GVHD / Người phản biện / Reviewer) ──────────────────────
  [Role.REVIEWER]: [
    // Project (Read-only)
    Permission.PROJECT_VIEW,
    Permission.PROJECT_READ,

    // Work Items (Read-only)
    Permission.WORK_ITEM_VIEW,
    Permission.WORK_ITEM_READ,

    // Manuscripts & Documents (Read & Comment)
    Permission.DOCUMENT_VIEW,
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_COMMENT,

    // Academic Library & Literature (Read, Annotate, Export citations)
    Permission.LIBRARY_VIEW,
    Permission.LIBRARY_READ,
    Permission.LIBRARY_ANNOTATE,
    Permission.LIBRARY_EXPORT,

    // Comments & Review (Create & manage own comments)
    Permission.COMMENT_VIEW,
    Permission.COMMENT_READ,
    Permission.COMMENT_CREATE,
    Permission.COMMENT_UPDATE_OWN,
    Permission.COMMENT_DELETE_OWN,

    // Storage & Research Assets (Read & download)
    Permission.FILE_VIEW,
    Permission.FILE_READ,
    Permission.FILE_DOWNLOAD,

    // Brainstorming Stickies (Read-only)
    Permission.STICKY_VIEW,
    Permission.STICKY_READ,

    // AI Research Assistant (Execute queries, RAG search)
    Permission.AI_EXECUTE,
    Permission.AI_RAG_SEARCH,
  ],
};

// ─── Helper Functions ────────────────────────────────────────────────────────
export function getPermissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] || [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions ? permissions.includes(permission) : false;
}

// ─── Aliases & Types ─────────────────────────────────────────────────────────
export type RolePermissionsMap = typeof ROLE_PERMISSIONS;
export const PROJECT_ROLE_PERMISSIONS = ROLE_PERMISSIONS;
