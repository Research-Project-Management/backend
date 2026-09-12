/**
 * Role Definitions & Hierarchy
 * Evaluated at the Project level across 4 standard roles:
 * - OWNER: Project Leader / PI (full control, member & settings management)
 * - CONTRIBUTOR: Research Member (tasks, documents, literature, canvas, AI)
 * - COMMENTER: Advisor / Reviewer (read, comment, annotate, cite)
 * - VIEWER: Guest / Evaluator (read-only)
 */
export enum Role {
  OWNER = 'owner', // Chủ trì đề tài / Trưởng nhóm — full control
  CONTRIBUTOR = 'contributor', // Thành viên nghiên cứu — tasks, papers, documents
  COMMENTER = 'commenter', // GVHD / Reviewer — view and comment
  VIEWER = 'viewer', // Hội đồng phản biện / Khách — read-only
}

export const RoleHierarchy: Record<Role, number> = {
  [Role.OWNER]: 40,
  [Role.CONTRIBUTOR]: 30,
  [Role.COMMENTER]: 20,
  [Role.VIEWER]: 10,
};

// ─── Human-readable Role Descriptions ─────────────────────────────────────────
export const ROLE_DESCRIPTIONS: Record<
  Role,
  { label: string; description: string }
> = {
  [Role.OWNER]: {
    label: 'Chủ nhiệm đề tài / Project Owner',
    description:
      'Toàn quyền quản lý dự án, cấu hình, quản lý thành viên và xóa dự án.',
  },
  [Role.CONTRIBUTOR]: {
    label: 'Thành viên nghiên cứu / Contributor',
    description:
      'Tạo và chỉnh sửa tasks, soạn thảo LaTeX, tải tài liệu nghiên cứu và canvas.',
  },
  [Role.COMMENTER]: {
    label: 'GVHD / Reviewer phản biện / Commenter',
    description:
      'Xem toàn bộ dữ liệu, viết nhận xét, ghi chú tài liệu và trích xuất trích dẫn.',
  },
  [Role.VIEWER]: {
    label: 'Hội đồng phản biện / Khách / Viewer',
    description: 'Chỉ có quyền xem dữ liệu đề tài nghiên cứu, không thể chỉnh sửa.',
  },
};

export const ProjectRole = Role;
export type ProjectRole = Role;
export const ProjectRoleHierarchy = RoleHierarchy;

export const WorkspaceRole = Role;
export type WorkspaceRole = Role;
export const WorkspaceRoleHierarchy = RoleHierarchy;

