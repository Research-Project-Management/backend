/**
 * Activity Domain Utilities
 *
 * Pure, stateless functions for formatting activity descriptions, verbs, and actor identifiers.
 */

export interface ActivitySummarySource {
  actorName?: string | null;
  verb: string;
  entityType: string;
  field?: string | null;
  newValue?: string | null;
}

/**
 * Builds a natural language summary of a domain activity event.
 */
export function buildActivitySummary(activity: ActivitySummarySource): string {
  const actor = activity.actorName || 'A member';
  const entity = activity.entityType.toLowerCase();

  switch (activity.verb.toLowerCase()) {
    case 'create':
    case 'created':
      return `${actor} created ${entity}${activity.newValue ? `: "${activity.newValue}"` : ''}`;
    case 'update':
    case 'updated':
      return `${actor} updated ${activity.field ? activity.field : entity}`;
    case 'delete':
    case 'deleted':
      return `${actor} deleted ${entity}`;
    case 'archive':
    case 'archived':
      return `${actor} archived ${entity}`;
    default:
      return `${actor} ${activity.verb} ${entity}`;
  }
}
