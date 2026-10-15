/**
 * track-changes/core/use-cases/resolve-comment-thread.use-case.ts
 * Inbound Use Case closing (resolving) or reopening an inline comment thread.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '@/modules/manuscripts/track-changes/core/ports/track-changes-repository.port';
import { IRealtimeNotifierPort } from '@/modules/manuscripts/track-changes/core/ports/realtime-notifier.port';
import { CommentThread } from '@/modules/manuscripts/track-changes/core/domain/entities/comment-thread.entity';
import { ThreadNotFoundException } from '@/modules/manuscripts/track-changes/core/domain/exceptions/thread-not-found.exception';

export interface ResolveCommentThreadInput {
  projectId: string;
  docId: string;
  threadId: string;
  resolve: boolean;
  userId?: string | null;
}

@Injectable()
export class ResolveCommentThreadUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly notifier: IRealtimeNotifierPort,
  ) {}

  public async execute(
    input: ResolveCommentThreadInput,
  ): Promise<CommentThread> {
    const { projectId, docId, threadId, resolve, userId } = input;

    const thread = await this.repository.findThreadById(threadId);
    if (!thread || thread.projectId !== projectId || thread.docId !== docId) {
      throw new ThreadNotFoundException(threadId);
    }

    if (resolve) {
      thread.resolve(userId);
    } else {
      thread.unresolve();
    }

    const saved = await this.repository.saveCommentThread(thread);
    this.notifier.notifyCommentResolved(projectId, docId, saved);

    return saved;
  }
}
