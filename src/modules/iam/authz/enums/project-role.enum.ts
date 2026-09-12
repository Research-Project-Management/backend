export enum ProjectRole {
  OWNER = 'owner',       // Trưởng nhóm nghiên cứu — full control
  ADMIN = 'admin',
  CONTRIBUTOR = 'contributor', // Thành viên nghiên cứu — create/edit
  COMMENTER = 'commenter',     // GVHD / Reviewer — view + comment
  VIEWER = 'viewer',           // Hội đồng — read-only
}

export const ProjectRoleHierarchy: Record<ProjectRole, number> = {
  [ProjectRole.OWNER]: 5,
  [ProjectRole.ADMIN]: 4,
  [ProjectRole.CONTRIBUTOR]: 3,
  [ProjectRole.COMMENTER]: 2,
  [ProjectRole.VIEWER]: 1,
};
