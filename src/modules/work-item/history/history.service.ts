import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import {
  CollaborationTab,
  FeedQueryDto,
  FeedSortOrder,
} from './dto/feed-query.dto';
import {
  formatTimeInStateBadge,
  resolveStateBadge,
} from './utils/time-in-state.util';
import { summarizeDiff } from './utils/diff.util';
import {
  StateBadge,
  StateTransitionItem,
  WorkItemTransitionsResponse,
} from './types/transition.types';
import {
  PropertyHistoryItem,
  WorkItemHistoryResponse,
} from './types/history.types';
import {
  UnifiedFeedItem,
  UnifiedFeedResponse,
} from './types/feed.types';

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);

  constructor(private readonly historyRepository: HistoryRepository) {}

  /**
   * Calculates state transitions and time-in-state badges (Plane.so Transition Tab).
   */
  async getTransitions(taskId: string): Promise<WorkItemTransitionsResponse> {
    const task = await this.historyRepository.findTaskWithProject(taskId);
    if (!task) {
      throw new NotFoundException(`Work item ${taskId} not found`);
    }

    const taskColumns = task.project?.taskColumns;
    const rawEvents = await this.historyRepository.findStateTransitions(taskId);

    const transitions: StateTransitionItem[] = [];
    let previousTimestamp = new Date(task.createdAt).getTime();

    for (const event of rawEvents) {
      const currentTimestamp = new Date(event.createdAt).getTime();
      const timeInStateMs = Math.max(0, currentTimestamp - previousTimestamp);
      const timeInStateBadge = formatTimeInStateBadge(timeInStateMs);

      const fromState: StateBadge = resolveStateBadge(event.oldValue, taskColumns);
      const toState: StateBadge = resolveStateBadge(event.newValue, taskColumns);

      transitions.push({
        id: event.id,
        fromState,
        toState,
        actor: event.actor,
        transitionedAt: event.createdAt,
        timeInStateMs,
        timeInStateBadge,
      });

      previousTimestamp = currentTimestamp;
    }

    const now = Date.now();
    const currentDurationMs = Math.max(0, now - previousTimestamp);
    const currentDurationBadge = formatTimeInStateBadge(currentDurationMs);

    const totalCycleTimeMs = Math.max(
      0,
      now - new Date(task.createdAt).getTime(),
    );
    const totalCycleTimeBadge = formatTimeInStateBadge(totalCycleTimeMs);

    const currentState: StateBadge = resolveStateBadge(
      task.columnId,
      taskColumns,
    );

    return {
      taskId,
      currentState,
      currentDurationMs,
      currentDurationBadge,
      totalCycleTimeMs,
      totalCycleTimeBadge,
      completed: Boolean(task.completed),
      transitions,
    };
  }

  /**
   * Returns property changelog history with structured before/after diffs (Plane.so History Tab).
   */
  async getHistory(
    taskId: string,
    sort: 'asc' | 'desc' = 'desc',
  ): Promise<WorkItemHistoryResponse> {
    const events = await this.historyRepository.findHistoryEvents(taskId, sort);

    const histories: PropertyHistoryItem[] = events.map((historyEvent) => ({
      id: historyEvent.id,
      field: historyEvent.field || 'property',
      oldValue: historyEvent.oldValue,
      newValue: historyEvent.newValue,
      actor: historyEvent.actor,
      createdAt: historyEvent.createdAt,
      diffSummary: summarizeDiff(historyEvent.field || '', historyEvent.oldValue, historyEvent.newValue),
    }));

    return {
      taskId,
      total: histories.length,
      histories,
    };
  }

  /**
   * Returns activity events for the work item (Plane.so Activity Tab).
   */
  async getActivity(taskId: string, sort: 'asc' | 'desc' = 'desc') {
    const events = await this.historyRepository.findTaskActivityEvents(taskId, sort);
    return {
      taskId,
      total: events.length,
      activities: events,
    };
  }

  /**
   * Unified collaboration feed combining comments, activity, transitions, history, worklogs.
   */
  async getUnifiedFeed(
    taskId: string,
    feedQueryDto: FeedQueryDto,
  ): Promise<UnifiedFeedResponse> {
    const tab = feedQueryDto.tab || CollaborationTab.ALL;
    const sort = feedQueryDto.sort || FeedSortOrder.DESC;
    const page = Number(feedQueryDto.page) || 1;
    const limit = Number(feedQueryDto.limit) || 50;

    let feedItems: UnifiedFeedItem[] = [];

    if (tab === CollaborationTab.COMMENTS) {
      const comments = await this.historyRepository.findTaskComments(taskId, sort);
      feedItems = comments.map((comment) => ({
        id: comment.id,
        type: 'comment',
        timestamp: comment.createdAt,
        actor: comment.author,
        comment: comment,
      }));
    } else if (tab === CollaborationTab.ACTIVITY) {
      const activities = await this.historyRepository.findTaskActivityEvents(
        taskId,
        sort,
      );
      feedItems = activities.map((activity) => ({
        id: activity.id,
        type: 'activity',
        timestamp: activity.createdAt,
        actor: activity.actor,
        activity: activity,
      }));
    } else if (tab === CollaborationTab.TRANSITION) {
      const transitionData = await this.getTransitions(taskId);
      const items: UnifiedFeedItem[] = transitionData.transitions.map((transition) => ({
        id: transition.id,
        type: 'transition' as const,
        timestamp: transition.transitionedAt,
        actor: transition.actor,
        transition: transition,
      }));
      if (sort === FeedSortOrder.DESC) {
        items.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
      } else {
        items.sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
      }
      feedItems = items;
    } else if (tab === CollaborationTab.HISTORY) {
      const historyData = await this.getHistory(taskId, sort);
      feedItems = historyData.histories.map((history) => ({
        id: history.id,
        type: 'history',
        timestamp: history.createdAt,
        actor: history.actor,
        history: history,
      }));
    } else if (tab === CollaborationTab.WORKLOGS) {
      const worklogs = await this.historyRepository.findTaskWorklogs(taskId, sort);
      feedItems = worklogs.map((worklog) => ({
        id: worklog.id,
        type: 'worklog',
        timestamp: worklog.createdAt,
        actor: worklog.user,
        worklog: worklog,
      }));
    } else {
      // Tab === 'all': Fetch comments, activities, and worklogs in parallel
      const [comments, activities, worklogs] = await Promise.all([
        this.historyRepository.findTaskComments(taskId, sort),
        this.historyRepository.findTaskActivityEvents(taskId, sort),
        this.historyRepository.findTaskWorklogs(taskId, sort),
      ]);

      const commentItems: UnifiedFeedItem[] = comments.map((comment) => ({
        id: comment.id,
        type: 'comment',
        timestamp: comment.createdAt,
        actor: comment.author,
        comment: comment,
      }));

      const activityItems: UnifiedFeedItem[] = activities.map((activity) => ({
        id: activity.id,
        type: activity.verb === 'transitioned' ? 'transition' : activity.field ? 'history' : 'activity',
        timestamp: activity.createdAt,
        actor: activity.actor,
        activity: activity,
      }));

      const worklogItems: UnifiedFeedItem[] = worklogs.map((worklog) => ({
        id: worklog.id,
        type: 'worklog',
        timestamp: worklog.createdAt,
        actor: worklog.user,
        worklog: worklog,
      }));

      feedItems = [...commentItems, ...activityItems, ...worklogItems];

      if (sort === FeedSortOrder.ASC) {
        feedItems.sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
      } else {
        feedItems.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
      }
    }

    const total = feedItems.length;
    const startIndex = (page - 1) * limit;
    const paginated = feedItems.slice(startIndex, startIndex + limit);

    return {
      taskId,
      tab,
      sort,
      total,
      feed: paginated,
    };
  }
}
