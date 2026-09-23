/**
 * track-changes/core/ports/realtime-notifier.port.ts
 * Outbound Port (SPI) for broadcasting review notifications (track changes, comments, replies) over WebSocket.
 */

import { TrackChange } from '../domain/entities/track-change.entity';
import { CommentThread } from '../domain/entities/comment-thread.entity';
import { CommentReply } from '../domain/entities/comment-reply.entity';

export abstract class IRealtimeNotifierPort {
  abstract notifyChangeRecorded(projectId: string, docId: string, change: TrackChange): void;
  abstract notifyChangeResolved(projectId: string, docId: string, change: TrackChange): void;
  abstract notifyCommentCreated(projectId: string, docId: string, thread: CommentThread): void;
  abstract notifyCommentReplied(
    projectId: string,
    docId: string,
    threadId: string,
    reply: CommentReply,
  ): void;
  abstract notifyCommentResolved(projectId: string, docId: string, thread: CommentThread): void;
}
