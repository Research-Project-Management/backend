import { Injectable, Logger } from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import { summarizeDiff } from './utils/diff.util';

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);

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
