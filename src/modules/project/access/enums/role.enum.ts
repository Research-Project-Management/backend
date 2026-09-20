/**
 * Role Definitions & Hierarchy
 * Evaluated at the Project level across 4 canonical roles:
 * - OWNER: Project Leader / PI (full administrative and member management authority)
 * - COORDINATOR: Project Coordinator (work management, cycles, triage, task assignment)
 * - CONTRIBUTOR: Research Member (work items, documents, literature, file uploads)
 * - REVIEWER: Advisor / Peer Reviewer (read-only with comments and suggestions)
 */
export enum Role {
  OWNER = 'owner',
  COORDINATOR = 'coordinator',
  CONTRIBUTOR = 'contributor',
  REVIEWER = 'reviewer',
}

export const RoleHierarchy: Record<Role, number> = {
  [Role.OWNER]: 40,
  [Role.COORDINATOR]: 30,
  [Role.CONTRIBUTOR]: 20,
  [Role.REVIEWER]: 10,
};

// ─── Human-readable Role Descriptions ─────────────────────────────────────────
export const ROLE_DESCRIPTIONS: Record<
  Role,
  { label: string; description: string }
> = {
  [Role.OWNER]: {
    label: 'Chủ nhiệm đề tài / Project Owner',
    description:
      'Toàn quyền quản lý dự án, cấu hình, độc quyền quản lý thành viên và xóa dự án.',
  },
  [Role.COORDINATOR]: {
    label: 'Điều phối viên / Project Coordinator',
    description:
      'Quản lý tiến độ, lập kế hoạch cycles, phân công và kiểm soát work items. Không có quyền quản lý nhân sự.',
  },
  [Role.CONTRIBUTOR]: {
    label: 'Thành viên nghiên cứu / Contributor',
    description:
      'Tạo và chỉnh sửa work items, soạn thảo tài liệu/LaTeX, tải tài liệu nghiên cứu.',
  },
  [Role.REVIEWER]: {
    label: 'GVHD / Phản biện / Reviewer',
    description:
      'Xem toàn bộ dữ liệu đề tài, viết nhận xét, ghi chú và đề xuất sửa đổi mà không thay đổi trực tiếp dữ liệu gốc.',
  },
};

export const ProjectRole = Role;
export type ProjectRole = Role;
export const ProjectRoleHierarchy = RoleHierarchy;
