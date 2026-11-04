import { StateGroup, STATE_GROUPS } from '@/modules/work-item/state/types/state.types';

/**
 * Declarative keyword rules for inferring StateGroup from state identifiers or names (OCP).
 */
export const STATE_GROUP_KEYWORD_RULES: ReadonlyArray<{
  group: StateGroup;
  keywords: ReadonlyArray<string>;
}> = [
  { group: 'backlog', keywords: ['backlog'] },
  {
    group: 'completed',
    keywords: ['done', 'completed', 'complete', 'closed', 'resolved'],
  },
  {
    group: 'cancelled',
    keywords: ['cancel', 'rejected', 'abandon', 'wontfix', "won't fix"],
  },
  {
    group: 'started',
    keywords: ['doing', 'progress', 'started', 'review', 'testing', 'qa', 'dev'],
  },
];

/**
 * Automatically infers the state group from a state identifier or name.
 */
export function inferStateGroup(
  id?: string | null,
  name?: string | null,
): StateGroup {
  const combined = `${id || ''} ${name || ''}`.toLowerCase().trim();

  for (const rule of STATE_GROUP_KEYWORD_RULES) {
    if (rule.keywords.some((kw) => combined.includes(kw))) {
      return rule.group;
    }
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

export interface StateMinimalDescriptor {
  id: string;
  name: string;
  group: string;
  isDefault?: boolean;
  projectId?: string;
}

/**
 * Determines whether a given state, state group, or work-item record represents a 'completed' state.
 */
export function isStateCompleted(
  stateOrGroup?:
    | {
        group?: string | null;
        state?: { group?: string | null } | null;
        columnId?: string | null;
        completed?: boolean | null;
      }
    | string
    | null,
): boolean {
  if (!stateOrGroup) return false;

  if (typeof stateOrGroup === 'string') {
    const normalized = stateOrGroup.toLowerCase().trim();
    return normalized === 'completed' || normalized === 'done';
  }

  if (typeof stateOrGroup === 'object') {
    if ('group' in stateOrGroup && typeof stateOrGroup.group === 'string') {
      return stateOrGroup.group.toLowerCase() === 'completed';
    }
    if (
      'state' in stateOrGroup &&
      stateOrGroup.state &&
      typeof stateOrGroup.state === 'object' &&
      typeof stateOrGroup.state.group === 'string'
    ) {
      return stateOrGroup.state.group.toLowerCase() === 'completed';
    }
    if ('columnId' in stateOrGroup || 'completed' in stateOrGroup) {
      return (
        stateOrGroup.columnId === 'done' ||
        stateOrGroup.columnId === 'completed' ||
        Boolean(stateOrGroup.completed)
      );
    }
  }

  return false;
}

export function matchProjectState<T extends StateMinimalDescriptor>(
  states: T[] | undefined,
  columnId?: string,
  allowFuzzyKeywords = false,
): T | undefined {
  if (!states || !columnId) return undefined;
  const normalizedCol = columnId.toLowerCase().trim();
  return states.find(
    (s) =>
      s.id === columnId ||
      s.name.toLowerCase() === normalizedCol ||
      s.group.toLowerCase() === normalizedCol ||
      (allowFuzzyKeywords &&
        (s.name.toLowerCase().replace(/[\s_-]+/g, '_') ===
          normalizedCol.replace(/[\s_-]+/g, '_') ||
          (normalizedCol.includes('progress') && s.group === 'started') ||
          (normalizedCol.includes('todo') && s.group === 'unstarted') ||
          (normalizedCol.includes('done') && s.group === 'completed'))),
  );
}

export async function resolveStateAndCompletionTransition(options: {
  projectId: string;
  states?: StateMinimalDescriptor[];
  columnId?: string;
  completed?: boolean;
  isCreate: boolean;
  existingStateGroup?: string;
  existingColumnId?: string;
  existingCompleted?: boolean;
  findStateById?: (
    stateId: string,
    projectId?: string,
  ) => Promise<StateMinimalDescriptor | null>;
  loadProjectStates?: (
    projectId: string,
  ) => Promise<StateMinimalDescriptor[] | undefined>;
}): Promise<{ columnId?: string; isCompleted?: boolean }> {
  const { projectId, columnId, completed, isCreate } = options;
  let states = options.states;

  if (isCreate) {
    const defaultState = states?.find((s) => s.isDefault) || states?.[0];
    let targetState =
      matchProjectState(states, columnId, true) || defaultState;

    if (completed === true && !isStateCompleted(targetState)) {
      const completedState = states?.find((s) => isStateCompleted(s));
      if (completedState) targetState = completedState;
    } else if (completed === false && isStateCompleted(targetState)) {
      if (defaultState && !isStateCompleted(defaultState)) {
        targetState = defaultState;
      }
    }

    const resolvedCol = targetState
      ? targetState.id
      : columnId || defaultState?.id || 'backlog';
    const isCompleted = targetState
      ? isStateCompleted(targetState)
      : isStateCompleted(resolvedCol || '');
    return { columnId: resolvedCol, isCompleted };
  }

  if (columnId !== undefined) {
    let targetState: StateMinimalDescriptor | null | undefined =
      options.findStateById
        ? await options.findStateById(columnId, projectId)
        : null;
    if (!targetState || (targetState.projectId && targetState.projectId !== projectId)) {
      if (!states && options.loadProjectStates) {
        states = await options.loadProjectStates(projectId);
      }
      targetState = matchProjectState(states, columnId, false);
    }
    const resolvedCol = targetState ? targetState.id : columnId;
    const isCompleted = targetState
      ? isStateCompleted(targetState)
      : isStateCompleted(resolvedCol);
    return { columnId: resolvedCol, isCompleted };
  }

  if (completed !== undefined) {
    if (!states && options.loadProjectStates) {
      states = await options.loadProjectStates(projectId);
    }
    const isCurrentlyCompleted = isStateCompleted({
      group: options.existingStateGroup,
      columnId: options.existingColumnId,
      completed: options.existingCompleted,
    });

    if (completed && !isCurrentlyCompleted) {
      const completedState = states?.find((s) => isStateCompleted(s));
      return {
        columnId: completedState?.id,
        isCompleted: true,
      };
    }
    if (!completed && isCurrentlyCompleted) {
      const unstartedState =
        states?.find((s) => s.isDefault) ||
        states?.find((s) => s.group === 'unstarted') ||
        states?.[0];
      return {
        columnId: unstartedState?.id,
        isCompleted: false,
      };
    }
    return { isCompleted: completed };
  }

  return {};
}
