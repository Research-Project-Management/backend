/**
 * track-changes/core/use-cases/create-comment-thread.use-case.ts
 * Inbound Use Case pinning a new comment thread to a text selection range in the document.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '@/modules/manuscripts/track-changes/core/ports/track-changes-repository.port';
import { IRealtimeNotifierPort } from '@/modules/manuscripts/track-changes/core/ports/realtime-notifier.port';
import { CommentThread } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-thread.entity';
import { CommentReply } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-reply.entity';
import {
  TextRangeVo,
  TextRangeProps,
} from '@/modules/manuscripts/track-changes/core/domain/value-objects/text-range.vo';

export interface CreateCommentThreadInput {
  projectId: string;
  docId: string;
  quote?: string | null;
  range: TextRangeProps;
  content: string;
  userId?: string | null;
}

@Injectable()
export class CreateCommentThreadUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly notifier: IRealtimeNotifierPort,
  ) {}

  public async execute(
    input: CreateCommentThreadInput,
  ): Promise<CommentThread> {
    const { projectId, docId, quote, range, content, userId } = input;

    const thread = CommentThread.create({
      projectId,
      docId,
      quote,
      range: TextRangeVo.create(range),
      createdById: userId,
    });

    if (content && content.trim()) {
      const initialReply = CommentReply.create({
        threadId: thread.id,
        content: content.trim(),
        createdById: userId,
      });
      thread.addReply(initialReply);
    }

    const saved = await this.repository.saveCommentThread(thread);
    this.notifier.notifyCommentCreated(projectId, docId, saved);

    return saved;
  }
}
