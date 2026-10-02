export interface MockWorkItem {
  id: string;
  projectId: string;
  authorId: string;
  columnId?: string;
  title: string;
  content?: string;
  status: string;
  priority: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Builds a valid mock Work-Item entity (Object Mother Pattern).
 */
export function buildMockWorkItem(
  overrides: Partial<MockWorkItem> = {},
): MockWorkItem {
  return {
    id: overrides.id ?? '01920b92-3333-7333-8333-333333333333',
    projectId: overrides.projectId ?? '01920b92-4444-7444-8444-444444444444',
    authorId: overrides.authorId ?? '01920b92-1111-7111-8111-111111111111',
    columnId: overrides.columnId ?? '01920b92-5555-7555-8555-555555555555',
    title: overrides.title ?? 'Implement Reference Graph Integration',
    content: overrides.content ?? 'Analyze dependency citation trees.',
    status: overrides.status ?? 'TODO',
    priority: overrides.priority ?? 'HIGH',
    order: overrides.order ?? 1,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
