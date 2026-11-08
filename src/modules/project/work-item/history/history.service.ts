import { Injectable } from '@nestjs/common';
import { HistoryRepository } from './history.repository';

type DiffFormatter = (
  oldVal: string,
  newVal: string,
  rawOld: string | null | undefined,
  rawNew: string | null | undefined,
) => string;

function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

const formatTitleDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed title from "${truncate(oldVal, 40)}" to "${truncate(newVal, 40)}"`;

const formatContentDiff: DiffFormatter = (_oldVal, _newVal, rawOld, rawNew) => {
  const oldLen = rawOld ? rawOld.length : 0;
  const newLen = rawNew ? rawNew.length : 0;
  const diff = newLen - oldLen;
  const sign = diff >= 0 ? `+${diff}` : `${diff}`;
  return `Updated description (${sign} chars)`;
};

const formatStateDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed state from "${oldVal}" to "${newVal}"`;

const formatPriorityDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed priority from "${oldVal}" to "${newVal}"`;

const formatAssigneeDiff: DiffFormatter = (oldVal, newVal) =>
  `Updated assignees: from ${oldVal} to ${newVal}`;

const formatLabelDiff: DiffFormatter = (oldVal, newVal) =>
  `Updated labels: from ${oldVal} to ${newVal}`;

const formatDueDateDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed due date to ${newVal} (was ${oldVal})`;

const formatStartDateDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed start date to ${newVal} (was ${oldVal})`;

const formatParentDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed parent to ${newVal} (was ${oldVal})`;

const formatTimeSpentDiff: DiffFormatter = (oldVal, newVal) =>
  `Updated time spent to ${newVal}h (was ${oldVal}h)`;

const formatStoryPointsDiff: DiffFormatter = (oldVal, newVal) =>
  `Changed story points from ${oldVal} to ${newVal}`;

export const DIFF_FIELD_FORMATTERS: Readonly<Record<string, DiffFormatter>> = {
  title: formatTitleDiff,
  description: formatContentDiff,
  content: formatContentDiff,
  state: formatStateDiff,
  status: formatStateDiff,
  columnid: formatStateDiff,
  stateid: formatStateDiff,
  priority: formatPriorityDiff,
  assignee: formatAssigneeDiff,
  assignees: formatAssigneeDiff,
  assigneeid: formatAssigneeDiff,
  label: formatLabelDiff,
  labels: formatLabelDiff,
  due_date: formatDueDateDiff,
  duedate: formatDueDateDiff,
  start_date: formatStartDateDiff,
  startdate: formatStartDateDiff,
  parent: formatParentDiff,
  parentid: formatParentDiff,
  parentworkitemid: formatParentDiff,
  time_spent: formatTimeSpentDiff,
  timespent: formatTimeSpentDiff,
  story_points: formatStoryPointsDiff,
  storypoints: formatStoryPointsDiff,
  point: formatStoryPointsDiff,
  points: formatStoryPointsDiff,
};

/**
 * Utility to generate concise diff summaries for work item property changes.
 * Open/Closed via DIFF_FIELD_FORMATTERS strategy registry.
 */
export function summarizeDiff(
  field: string,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
): string {
  const oldVal = oldValue ?? '(none)';
  const newVal = newValue ?? '(none)';
  const formatter = DIFF_FIELD_FORMATTERS[field.toLowerCase()];
  if (formatter) {
    return formatter(oldVal, newVal, oldValue, newValue);
  }
  return `Updated ${field}: ${truncate(oldVal, 30)} → ${truncate(newVal, 30)}`;
}

@Injectable()
export class HistoryService {
  constructor(private readonly historyRepository: HistoryRepository) {}

  /**
   * Returns activity events for the work item.
   */
  async getActivity(workItemId: string, sort: 'asc' | 'desc' = 'desc') {
    const events = await this.historyRepository.findWorkItemActivityEvents(
      workItemId,
      sort,
    );

    const activities = events.map((event) => ({
      ...event,
      user: event.actor,
      message: event.field
        ? summarizeDiff(event.field, event.oldValue, event.newValue)
        : `${event.actor?.name || 'User'} ${event.verb || 'updated'} this item`,
    }));

    return {
      workItemId,
      total: activities.length,
      activities,
    };
  }
}
