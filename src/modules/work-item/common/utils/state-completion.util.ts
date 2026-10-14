/**
 * Utility to determine whether a given state or state group represents a 'completed' state.
 * Shared across core, state, rank calculation, and other submodules without introducing circular dependencies.
 */

export function isStateCompleted(
  stateOrGroup?: { group?: string | null } | string | null,
): boolean {
  if (!stateOrGroup) return false;

  if (typeof stateOrGroup === 'string') {
    return stateOrGroup.toLowerCase() === 'completed';
  }

  if (
    typeof stateOrGroup === 'object' &&
    stateOrGroup !== null &&
    'group' in stateOrGroup
  ) {
    return stateOrGroup.group === 'completed';
  }

  return false;
}
