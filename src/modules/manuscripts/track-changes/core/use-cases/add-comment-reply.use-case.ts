/**
 * track-changes/core/use-cases/add-comment-reply.use-case.ts
 * Inbound Use Case adding a new message/reply into an active comment thread.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '../ports/track-changes-repository.port';
import { IRealtimeNotifierPort } from '../ports/realtime-notifier.port';
import { CommentReply } from '../domain/entities/comment-reply.entity';
import { ThreadNotFoundException } from '../domain/exceptions/thread-not-found.exception';
import { ResolvedThreadException } from '../domain/exceptions/resolved-thread.exception';

export interface AddCommentReplyInput {
  projectId: string;
  docId: string;
  threadId: string;
  content: string;
  userId?: string | null;
}

@Injectable()
export class AddCommentReplyUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly notifier: IRealtimeNotifierPort,
  ) {}

  public async execute(input: AddCommentReplyInput): Promise<CommentReply> {
    const { projectId, docId, threadId, content, userId } = input;

    const thread = await this.repository.findThreadById(threadId);
    if (!thread || thread.projectId !== projectId || thread.docId !== docId) {
      throw new ThreadNotFoundException(threadId);
    }

    if (thread.isResolved) {
      throw new ResolvedThreadException(threadId);
    }

    const reply = CommentReply.create({
      threadId,
      content,
      createdById: userId,
    });

    const saved = await this.repository.addCommentReply(threadId, reply);
    this.notifier.notifyCommentReplied(projectId, docId, threadId, saved);

    return saved;
  }
}
