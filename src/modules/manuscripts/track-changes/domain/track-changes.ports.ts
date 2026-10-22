/**
 * track-changes/domain/track-changes.ports.ts
 * Outbound Ports (SPI) and operation contracts for Track Changes & Review Mode.
 */

import { TrackChange, ChangeStatus } from './track-change.entity';
import { CommentThread } from './comment-thread.entity';
import { CommentReply } from './comment-reply.entity';

export type BatchAction =
  'accept_all' | 'reject_all' | 'accept_selected' | 'reject_selected';

export interface PatcherResult {
  lines: string[];
  newRev: number;
}

export abstract class ITrackChangesRepositoryPort {
  abstract saveChange(change: TrackChange): Promise<TrackChange>;
  abstract findChangeById(changeId: string): Promise<TrackChange | null>;
  abstract listChangesByDoc(
    projectId: string,
    docId: string,
    status?: ChangeStatus,
  ): Promise<TrackChange[]>;

  abstract batchUpdateChangesStatus(
    ids: string[],
    status: ChangeStatus,
    resolvedById?: string | null,
    resolvedAt?: Date | null,
  ): Promise<void>;

  abstract saveCommentThread(thread: CommentThread): Promise<CommentThread>;
  abstract findThreadById(threadId: string): Promise<CommentThread | null>;
  abstract listThreadsByDoc(
    projectId: string,
    docId: string,
    isResolved?: boolean,
  ): Promise<CommentThread[]>;

  abstract addCommentReply(
    threadId: string,
    reply: CommentReply,
  ): Promise<CommentReply>;
}

export abstract class IDocstorePatcherPort {
  abstract applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult>;

  abstract revertChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult>;
}

export abstract class IRealtimeNotifierPort {
  abstract notifyChangeRecorded(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): void;
  abstract notifyChangeResolved(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): void;
  abstract notifyCommentCreated(
    projectId: string,
    docId: string,
    thread: CommentThread,
  ): void;
  abstract notifyCommentReplied(
    projectId: string,
    docId: string,
    threadId: string,
    reply: CommentReply,
    threadOwnerId?: string | null,
  ): void;
  abstract notifyCommentResolved(
    projectId: string,
    docId: string,
    thread: CommentThread,
  ): void;
}
