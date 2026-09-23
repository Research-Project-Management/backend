/**
 * track-changes/core/ports/track-changes-repository.port.ts
 * Outbound Port (SPI) for persisting and querying track changes and inline comments in PostgreSQL.
 */

import { TrackChange, ChangeStatus } from '../domain/entities/track-change.entity';
import { CommentThread } from '../domain/entities/comment-thread.entity';
import { CommentReply } from '../domain/entities/comment-reply.entity';

export abstract class ITrackChangesRepositoryPort {
  abstract saveChange(change: TrackChange): Promise<TrackChange>;
  abstract findChangeById(changeId: string): Promise<TrackChange | null>;
  abstract listChangesByDoc(
    projectId: string,
    docId: string,
    status?: ChangeStatus,
  ): Promise<TrackChange[]>;

  abstract saveCommentThread(thread: CommentThread): Promise<CommentThread>;
  abstract findThreadById(threadId: string): Promise<CommentThread | null>;
  abstract listThreadsByDoc(
    projectId: string,
    docId: string,
    isResolved?: boolean,
  ): Promise<CommentThread[]>;

  abstract addCommentReply(threadId: string, reply: CommentReply): Promise<CommentReply>;
  abstract deleteCommentThread(projectId: string, threadId: string): Promise<void>;
}
