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
import { UnifiedFeedItem, UnifiedFeedResponse } from './types/feed.types';

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);

  constructor(private readonly historyRepository: HistoryRepository) {}

  /**
   * Calculates state transitions and time-in-state badges (Plane.so Transition Tab).
   */
  async getTransitions(
    workItemId: string,
  ): Promise<WorkItemTransitionsResponse> {
    const workItem =
      await this.historyRepository.findWorkItemWithProject(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const states = workItem.project?.states || [];
    const rawEvents =
      await this.historyRepository.findStateTransitions(workItemId);

    const transitions: StateTransitionItem[] = [];
    let previousTimestamp = new Date(workItem.createdAt).getTime();

    for (const event of rawEvents) {
      const currentTimestamp = new Date(event.createdAt).getTime();
      const timeInStateMs = Math.max(0, currentTimestamp - previousTimestamp);
      const timeInStateBadge = formatTimeInStateBadge(timeInStateMs);

      const fromState: StateBadge = resolveStateBadge(event.oldValue, states);
      const toState: StateBadge = resolveStateBadge(event.newValue, states);

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
      now - new Date(workItem.createdAt).getTime(),
    );
    const totalCycleTimeBadge = formatTimeInStateBadge(totalCycleTimeMs);

    const currentState: StateBadge = resolveStateBadge(
      workItem.columnId,
      states,
    );

    return {
      workItemId,
      currentState,
      currentDurationMs,
      currentDurationBadge,
      totalCycleTimeMs,
      totalCycleTimeBadge,
      completed: Boolean(workItem.completed),
      transitions,
    };
  }

  /**
   * Returns property changelog history with structured before/after diffs (Plane.so History Tab).
   */
  async getHistory(
    workItemId: string,
    sort: 'asc' | 'desc' = 'desc',
  ): Promise<WorkItemHistoryResponse> {
    const events = await this.historyRepository.findHistoryEvents(
      workItemId,
      sort,
    );

    const histories: PropertyHistoryItem[] = events.map((historyEvent) => ({
      id: historyEvent.id,
      field: historyEvent.field || 'property',
      oldValue: historyEvent.oldValue,
      newValue: historyEvent.newValue,
      actor: historyEvent.actor,
      createdAt: historyEvent.createdAt,
      diffSummary: summarizeDiff(
        historyEvent.field || '',
        historyEvent.oldValue,
        historyEvent.newValue,
      ),
    }));

    return {
      workItemId,
      total: histories.length,
      histories,
    };
  }

  /**
   * Returns activity events for the work item (Plane.so Activity Tab).
   */
  async getActivity(workItemId: string, sort: 'asc' | 'desc' = 'desc') {
    const events = await this.historyRepository.findWorkItemActivityEvents(
      workItemId,
      sort,
    );
    return {
      workItemId,
      total: events.length,
      activities: events,
    };
  }

  /**
   * Unified collaboration feed combining comments, activity, transitions, history.
   */
  async getUnifiedFeed(
    workItemId: string,
    feedQueryDto: FeedQueryDto,
  ): Promise<UnifiedFeedResponse> {
    const tab = feedQueryDto.tab || CollaborationTab.ALL;
    const sort = feedQueryDto.sort || FeedSortOrder.DESC;
    const page = Number(feedQueryDto.page) || 1;
    const limit = Number(feedQueryDto.limit) || 50;

    let feedItems: UnifiedFeedItem[] = [];

    if (tab === CollaborationTab.COMMENTS) {
      const comments = await this.historyRepository.findWorkItemComments(
        workItemId,
        sort,
      );
      feedItems = comments.map((comment) => ({
        id: comment.id,
        type: 'comment',
        timestamp: comment.createdAt,
        actor: comment.author,
        comment: comment,
      }));
    } else if (tab === CollaborationTab.ACTIVITY) {
      const events = await this.historyRepository.findWorkItemActivityEvents(
        workItemId,
        sort,
      );
      feedItems = events.map((activity) => ({
        id: activity.id,
        type:
          activity.verb === 'transitioned'
            ? 'transition'
            : activity.field
              ? 'history'
              : 'activity',
        timestamp: activity.createdAt,
        actor: activity.actor,
        activity: activity,
      }));
    } else if (tab === CollaborationTab.TRANSITION) {
      const transitionData = await this.getTransitions(workItemId);
      const items: UnifiedFeedItem[] = transitionData.transitions.map(
        (transition) => ({
          id: transition.id,
          type: 'transition' as const,
          timestamp: transition.transitionedAt,
          actor: transition.actor,
          transition: transition,
        }),
      );
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
      const historyData = await this.getHistory(workItemId, sort);
      feedItems = historyData.histories.map((history) => ({
        id: history.id,
        type: 'history',
        timestamp: history.createdAt,
        actor: history.actor,
        history: history,
      }));
    } else {
      // Tab === 'all': Fetch comments and activities in parallel
      const [comments, activities] = await Promise.all([
        this.historyRepository.findWorkItemComments(workItemId, sort),
        this.historyRepository.findWorkItemActivityEvents(workItemId, sort),
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
        type:
          activity.verb === 'transitioned'
            ? 'transition'
            : activity.field
              ? 'history'
              : 'activity',
        timestamp: activity.createdAt,
        actor: activity.actor,
        activity: activity,
      }));

      feedItems = [...commentItems, ...activityItems];

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
      workItemId,
      tab,
      sort,
      total,
      feed: paginated,
    };
  }
}
