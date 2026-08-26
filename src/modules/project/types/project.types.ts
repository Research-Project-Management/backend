/**
 * Task Column definition for Kanban / Project boards
 */
export interface TaskColumn {
  id: string;
  title: string;
  isDefault?: boolean;
  accentColor?: string;
}

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
