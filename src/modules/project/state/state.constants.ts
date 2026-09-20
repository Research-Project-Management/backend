export interface DefaultProjectStateTemplate {
  name: string;
  description: string;
  color: string;
  sequence: number;
  isDefault: boolean;
}

/**
 * 8 Default Research Project States to seed when a new project is created.
 * Users can customize, reorder (drag & drop), add new, or delete any of these.
 * States are purely dynamic data in the database (table project_states).
 */
export const DEFAULT_PROJECT_STATES: DefaultProjectStateTemplate[] = [
  {
    name: 'Thuyết minh đề cương',
    description:
      'Phác thảo ý tưởng nghiên cứu, tổng quan tài liệu (Literature Review), thiết kế phương pháp và mục tiêu.',
    color: '#0284c7',
    sequence: 0,
    isDefault: true,
  },
  {
    name: 'Thẩm định & Phê duyệt',
    description:
      'Đề cương đang được hội đồng khoa học, hội đồng đạo đức hoặc tổ chức tài trợ xem xét, thẩm định tính khả thi.',
    color: '#8b5cf6',
    sequence: 1,
    isDefault: false,
  },
  {
    name: 'Triển khai & Thực nghiệm',
    description:
      'Đội ngũ đang tích cực thu thập dữ liệu, chạy mô phỏng, thí nghiệm và phân tích kết quả.',
    color: '#f59e0b',
    sequence: 2,
    isDefault: false,
  },
  {
    name: 'Soạn thảo & Công bố',
    description:
      'Đã có dữ liệu cốt lõi; đang tập trung soạn thảo bài báo khoa học (LaTeX), gửi bình duyệt hoặc viết báo cáo tổng kết.',
    color: '#3b82f6',
    sequence: 3,
    isDefault: false,
  },
  {
    name: 'Nghiệm thu & Đánh giá',
    description:
      'Phản biện độc lập, đánh giá kết quả và bảo vệ trước hội đồng nghiệm thu.',
    color: '#a855f7',
    sequence: 4,
    isDefault: false,
  },
  {
    name: 'Hoàn thành & Lưu trữ',
    description:
      'Đề tài đã nghiệm thu thành công, nộp lưu chiểu báo cáo, công bố dữ liệu và bài báo chính thức.',
    color: '#10b981',
    sequence: 5,
    isDefault: false,
  },
  {
    name: 'Tạm dừng',
    description:
      'Đề tài tạm hoãn do chờ kinh phí, thiếu mẫu vật, sự cố thiết bị hoặc thay đổi nhân sự.',
    color: '#f97316',
    sequence: 6,
    isDefault: false,
  },
  {
    name: 'Hủy bỏ',
    description:
      'Đề tài bị đình chỉ hoặc chấm dứt do không khả thi, vi phạm quy chế hoặc thay đổi định hướng.',
    color: '#ef4444',
    sequence: 7,
    isDefault: false,
  },
];

