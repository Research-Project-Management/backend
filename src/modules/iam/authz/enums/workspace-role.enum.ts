/**
 * WorkspaceRole — simplified for personal workspace model.
 *
 * In the new architecture, each workspace is personal (1-to-1 with User).
 * There are no workspace-level member roles. Collaboration happens exclusively
 * at the project level via ProjectMemberRole.
 *
 * This enum is kept for backward compatibility in guards/controllers
 * that reference workspace ownership checks. Effectively: a user is either
 * the owner of their own workspace, or has no workspace-level access.
 */
export enum WorkspaceRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
}

export const WorkspaceRoleHierarchy: Record<WorkspaceRole, number> = {
  [WorkspaceRole.OWNER]: 100,
  [WorkspaceRole.ADMIN]: 80,
  [WorkspaceRole.MEMBER]: 50,
  [WorkspaceRole.VIEWER]: 10,
};
