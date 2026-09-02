/**
 * Task Column definition for Kanban / Project boards
 */
export interface TaskColumn {
  id: string;
  title: string;
  isDefault?: boolean;
  accentColor?: string;
}

export const DEFAULT_TASK_COLUMNS: TaskColumn[] = [
  { id: 'backlog', title: 'Backlog', isDefault: true, accentColor: '#6B7280' },
  { id: 'todo', title: 'To Do', isDefault: true, accentColor: '#3B82F6' },
  { id: 'in-progress', title: 'In Progress', isDefault: true, accentColor: '#F59E0B' },
  { id: 'done', title: 'Done', isDefault: true, accentColor: '#10B981' },
];

/**
 * Checklist item in a Task
 */
export interface TaskChecklistItem {
  id: string;
  title: string;
  completed: boolean;
}

/**
 * Safe parser for Project taskColumns JSON field
 */
export function parseTaskColumns(raw: unknown): TaskColumn[] {
  if (!raw || !Array.isArray(raw)) return [];
  const list: unknown[] = raw;
  return list.filter(
    (item: unknown): item is TaskColumn =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      'title' in item &&
      typeof (item as Record<string, unknown>).title === 'string',
  );
}

/**
 * Safe parser for Task checklists JSON field
 */
export function parseTaskChecklists(raw: unknown): TaskChecklistItem[] {
  if (!raw || !Array.isArray(raw)) return [];
  const list: unknown[] = raw;
  return list.filter(
    (item: unknown): item is TaskChecklistItem =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      'title' in item &&
      typeof (item as Record<string, unknown>).title === 'string' &&
      'completed' in item &&
      typeof (item as Record<string, unknown>).completed === 'boolean',
  );
}
