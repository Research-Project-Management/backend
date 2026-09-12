/**
 * Utility to generate concise diff summaries for work item property changes.
 */
export function summarizeDiff(
  field: string,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
): string {
  const oldVal = oldValue ?? '(none)';
  const newVal = newValue ?? '(none)';

  switch (field.toLowerCase()) {
    case 'title':
      return `Changed title from "${truncate(oldVal, 40)}" to "${truncate(newVal, 40)}"`;

    case 'description':
    case 'content': {
      const oldLen = oldValue ? oldValue.length : 0;
      const newLen = newValue ? newValue.length : 0;
      const diff = newLen - oldLen;
      const sign = diff >= 0 ? `+${diff}` : `${diff}`;
      return `Updated description (${sign} chars)`;
    }

    case 'state':
    case 'status':
      return `Changed state from "${oldVal}" to "${newVal}"`;

    case 'priority':
      return `Changed priority from "${oldVal}" to "${newVal}"`;

    case 'assignee':
    case 'assignees':
      return `Updated assignees: from ${oldVal} to ${newVal}`;

    case 'label':
    case 'labels':
      return `Updated labels: from ${oldVal} to ${newVal}`;

    case 'cycle':
      return `Moved to cycle: "${newVal}" (was "${oldVal}")`;

    case 'module':
      return `Updated module: "${newVal}" (was "${oldVal}")`;

    case 'due_date':
    case 'duedate':
      return `Changed due date to ${newVal} (was ${oldVal})`;

    case 'story_points':
    case 'storypoints':
    case 'point':
    case 'points':
      return `Changed story points from ${oldVal} to ${newVal}`;

    default:
      return `Updated ${field}: ${truncate(oldVal, 30)} → ${truncate(newVal, 30)}`;
  }
}

function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
