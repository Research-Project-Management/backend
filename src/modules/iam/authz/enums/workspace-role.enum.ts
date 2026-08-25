export enum WorkspaceRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export const WorkspaceRoleHierarchy: Record<WorkspaceRole, number> = {
  [WorkspaceRole.OWNER]: 100,
  [WorkspaceRole.ADMIN]: 75,
  [WorkspaceRole.MEMBER]: 50,
  [WorkspaceRole.VIEWER]: 25,
};
