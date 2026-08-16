export enum ProjectRole {
  ADMIN = 'admin',
  CONTRIBUTOR = 'contributor',
  COMMENTER = 'commenter',
  VIEWER = 'viewer',
}

export const ProjectRoleHierarchy: Record<ProjectRole, number> = {
  [ProjectRole.VIEWER]: 1,
  [ProjectRole.COMMENTER]: 2,
  [ProjectRole.CONTRIBUTOR]: 3,
  [ProjectRole.ADMIN]: 4,
};
