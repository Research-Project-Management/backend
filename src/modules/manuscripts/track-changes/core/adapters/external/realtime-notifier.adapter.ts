/**
 * track-changes/core/adapters/external/realtime-notifier.adapter.ts
 * Driven Adapter implementing IRealtimeNotifierPort using RealtimeService to broadcast updates.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { IRealtimeNotifierPort } from '../../ports/realtime-notifier.port';
import { TrackChange } from '../../domain/entities/track-change.entity';
import { CommentThread } from '../../domain/entities/comment-thread.entity';
import { CommentReply } from '../../domain/entities/comment-reply.entity';
import { RealtimeService } from '@/modules/manuscripts/realtime/realtime.service';

@Injectable()
export class RealtimeNotifierAdapter extends IRealtimeNotifierPort {
  private readonly logger = new Logger(RealtimeNotifierAdapter.name);

  constructor(@Optional() private readonly realtimeService?: RealtimeService) {
    super();
  }

  public notifyChangeRecorded(projectId: string, docId: string, change: TrackChange): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'track-changes:recorded', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyChangeResolved(projectId: string, docId: string, change: TrackChange): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'track-changes:resolved', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyCommentCreated(projectId: string, docId: string, thread: CommentThread): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'comment:created', {
      docId,
      thread: thread.toJSON(),
    });
  }

  public notifyCommentReplied(
    projectId: string,
    docId: string,
    threadId: string,
    reply: CommentReply,
  ): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'comment:replied', {
      docId,
      threadId,
      reply: reply.toJSON(),
    });
  }

  public notifyCommentResolved(projectId: string, docId: string, thread: CommentThread): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'comment:resolved', {
      docId,
      thread: thread.toJSON(),
    });
  }
}
