import { ProjectState } from '@prisma/client';

export interface ProjectStateMetadata {
  state: ProjectState;
  label: string;
  description: string;
  order: number;
}

export const PROJECT_STATES_CATALOG: ProjectStateMetadata[] = [
  {
    state: 'draft',
    label: 'Bản nháp (Draft)',
    description:
      'Dự án đang trong giai đoạn phác thảo ý tưởng, chưa chốt duyệt kế hoạch.',
    order: 1,
  },
  {
    state: 'planning',
    label: 'Lên kế hoạch (Planning)',
    description: 'Đang xác định scope, specs, kiến trúc và phân bổ tài nguyên.',
    order: 2,
  },
  {
    state: 'execution',
    label: 'Đang triển khai (Execution / In Progress)',
    description:
      'Đội ngũ đang tích cực thực thi, viết mã và hoàn thiện các work-items.',
    order: 3,
  },
  {
    state: 'monitoring',
    label: 'Giám sát & Đánh giá (Monitoring / Review)',
    description:
      'Kiểm thử, thử nghiệm beta, nghiệm thu chất lượng trước khi hoàn thành.',
    order: 4,
  },
  {
    state: 'completed',
    label: 'Hoàn thành (Completed)',
    description:
      'Dự án đã nghiệm thu thành công và hoàn tất toàn bộ mục tiêu đề ra.',
    order: 5,
  },
  {
    state: 'cancelled',
    label: 'Hủy bỏ / Tạm dừng (Cancelled)',
    description: 'Dự án tạm hoãn hoặc bị hủy bỏ do thay đổi định hướng.',
    order: 6,
  },
];

/**
 * Valid state transitions for project lifecycle
 */
export const ALLOWED_STATE_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  draft: ['planning', 'cancelled'],
  planning: ['draft', 'execution', 'cancelled'],
  execution: ['planning', 'monitoring', 'completed', 'cancelled'],
  monitoring: ['execution', 'completed', 'cancelled'],
  completed: ['monitoring', 'execution'], // Re-open if needed
  cancelled: ['draft', 'planning'], // Revive project
};
