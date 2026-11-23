import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

const logger = new Logger('ReviewEvents');

export const REVIEW_EVENTS = {
  STATUS_CHANGED: 'review:status-changed',
  SUGGESTION_CREATED: 'track-changes:created',
  SUGGESTION_RESOLVED: 'track-changes:resolved',
  COMMENT_CREATED: 'comment:created',
  COMMENT_UPDATED: 'comment:updated',
  COMMENT_DELETED: 'comment:deleted',
  COMMENT_RESOLVED: 'comment:resolved',
  REPLY_ADDED: 'comment:reply-added',
  REPLY_UPDATED: 'comment:reply-updated',
  REPLY_DELETED: 'comment:reply-deleted',
} as const;

export function emitReviewEvent(
  eventEmitter: EventEmitter2 | undefined,
  spaceId: string | null | undefined,
  event: string,
  payload: unknown,
): void {
  if (!spaceId || !eventEmitter) return;
  try {
    eventEmitter.emit('pages.project.event', {
      projectId: spaceId,
      event,
      payload,
    });
  } catch (error) {
    logger.warn(
      `Failed to emit review event "${event}" for space "${spaceId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
