import {
  DEFAULT_WORK_ITEM_STATES,
  StateGroup,
  STATE_GROUPS,
  WorkItemState,
} from '../types/state.types';

/**
 * Automatically infers the state group from a state identifier or name.
 * Used for migrating legacy Project taskColumns into state groups.
 */
export function inferStateGroup(
  id?: string | null,
  name?: string | null,
): StateGroup {
  const combined = `${id || ''} ${name || ''}`.toLowerCase().trim();

  if (combined.includes('backlog')) {
    return 'backlog';
  }

  if (
    combined.includes('done') ||
    combined.includes('completed') ||
    combined.includes('complete') ||
    combined.includes('closed') ||
    combined.includes('resolved')
  ) {
    return 'completed';
  }

  if (
    combined.includes('cancel') ||
    combined.includes('rejected') ||
    combined.includes('abandon') ||
    combined.includes('wontfix') ||
    combined.includes("won't fix")
  ) {
    return 'cancelled';
  }

  if (
    combined.includes('doing') ||
    combined.includes('progress') ||
    combined.includes('started') ||
    combined.includes('review') ||
    combined.includes('testing') ||
    combined.includes('qa') ||
    combined.includes('dev')
  ) {
    return 'started';
  }

  // Fallback for To Do / New / Unstarted
  return 'unstarted';
}

/**
 * Validates whether a value is a recognised state group.
 */
export function isValidStateGroup(value: unknown): value is StateGroup {
  return (
    typeof value === 'string' && STATE_GROUPS.includes(value as StateGroup)
  );
}

/**
 * Safely parses and normalizes raw JSON data from Project.taskColumns
 * into full WorkItemState objects.
 */
export function parseWorkItemStates(raw: unknown): WorkItemState[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_WORK_ITEM_STATES];
  }

  const result: WorkItemState[] = [];

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== 'object') continue;

    const rawObj = item as Record<string, unknown>;
    const rawId =
      typeof rawObj.id === 'string' && rawObj.id.trim()
        ? rawObj.id.trim()
        : `state-${index + 1}`;

    const rawName =
      typeof rawObj.name === 'string' && rawObj.name.trim()
        ? rawObj.name.trim()
        : typeof rawObj.title === 'string' && rawObj.title.trim()
          ? rawObj.title.trim()
          : `Status ${index + 1}`;

    const rawColor =
      typeof rawObj.color === 'string' && rawObj.color.trim()
        ? rawObj.color.trim()
        : typeof rawObj.accentColor === 'string' && rawObj.accentColor.trim()
          ? rawObj.accentColor.trim()
          : '#6366F1';

    const group: StateGroup = isValidStateGroup(rawObj.group)
      ? rawObj.group
      : inferStateGroup(rawId, rawName);

    const sequence =
      typeof rawObj.sequence === 'number' && !isNaN(rawObj.sequence)
        ? rawObj.sequence
        : (index + 1) * 1000;

    const isDefault = Boolean(rawObj.isDefault);
    const description =
      typeof rawObj.description === 'string' ? rawObj.description : undefined;

    result.push({
      id: rawId,
      name: rawName,
      title: rawName,
      color: rawColor,
      accentColor: rawColor,
      group,
      sequence,
      isDefault,
      description,
    });
  }

  if (result.length === 0) {
    return [...DEFAULT_WORK_ITEM_STATES];
  }

  // Ensure exactly one state is flagged as default
  const defaultCount = result.filter((state) => state.isDefault).length;
  if (defaultCount === 0) {
    // Pick backlog or first unstarted as default
    const preferredDefault =
      result.find((state) => state.group === 'backlog') ||
      result.find((state) => state.group === 'unstarted') ||
      result[0];
    preferredDefault.isDefault = true;
  } else if (defaultCount > 1) {
    // Keep only the first default
    let foundFirst = false;
    for (const state of result) {
      if (state.isDefault) {
        if (!foundFirst) {
          foundFirst = true;
        } else {
          state.isDefault = false;
        }
      }
    }
  }

  // Sort by sequence ascending
  result.sort((firstState, secondState) => firstState.sequence - secondState.sequence);

  return result;
}

/**
 * Checks if a given state or group belongs to the completed group.
 * Only items in the 'completed' group count as completed.
 */
export function isStateCompleted(
  stateOrGroup?: WorkItemState | string | null,
): boolean {
  if (!stateOrGroup) return false;

  if (typeof stateOrGroup === 'string') {
    return stateOrGroup.toLowerCase() === 'completed';
  }

  if ('group' in stateOrGroup) {
    return stateOrGroup.group === 'completed';
  }

  return false;
}

/**
 * Generates a URL-friendly unique slug from a state name.
 */
export function generateStateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
