import { StateBadge } from '../types/transition.types';

/**
 * Formats duration into a concise Plane.so badge format (e.g. "54m", "1d 4h", "3d").
 */
export function formatTimeInStateBadge(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/**
 * Resolves a state ID or slug into a StateBadge with name, color, and group.
 */
export function resolveStateBadge(
  stateId: string | null | undefined,
  taskColumns: any,
): StateBadge {
  if (!stateId) {
    return { id: '', name: 'None', color: '#94a3b8', group: 'backlog' };
  }

  const columns = Array.isArray(taskColumns) ? taskColumns : [];
  const found = columns.find((c: any) => c.id === stateId || c.slug === stateId);
  if (found) {
    return {
      id: found.id || stateId,
      name: found.title || found.name || stateId,
      color: found.accentColor || found.color || '#3b82f6',
      group: found.group || 'unstarted',
    };
  }

  // Fallback defaults for standard slugs
  const lower = stateId.toLowerCase();
  if (lower.includes('backlog')) {
    return { id: stateId, name: 'Backlog', color: '#94a3b8', group: 'backlog' };
  }
  if (lower.includes('todo') || lower.includes('unstarted')) {
    return { id: stateId, name: 'To Do', color: '#64748b', group: 'unstarted' };
  }
  if (lower.includes('progress') || lower.includes('started')) {
    return { id: stateId, name: 'In Progress', color: '#3b82f6', group: 'started' };
  }
  if (lower.includes('done') || lower.includes('complete')) {
    return { id: stateId, name: 'Completed', color: '#10b981', group: 'completed' };
  }
  if (lower.includes('cancel')) {
    return { id: stateId, name: 'Cancelled', color: '#ef4444', group: 'cancelled' };
  }

  return { id: stateId, name: stateId, color: '#3b82f6', group: 'custom' };
}
