export enum ProjectRole {
  ADMIN = 'admin',
  CONTRIBUTOR = 'contributor',
  COMMENTER = 'commenter',
  VIEWER = 'viewer',
}

export const ProjectRoleHierarchy: Record<ProjectRole, number> = {
  [ProjectRole.ADMIN]: 4,
  [ProjectRole.CONTRIBUTOR]: 3,
  [ProjectRole.COMMENTER]: 2,
  [ProjectRole.VIEWER]: 1,
};
