/**
 * track-changes/core/use-cases/get-doc-reviews.use-case.ts
 * Inbound Use Case aggregating all track changes and comment threads for a document.
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '../ports/track-changes-repository.port';
import { TrackChange } from '../domain/entities/track-change.entity';
import { CommentThread } from '../domain/entities/comment-thread.entity';

export interface GetDocReviewsOutput {
  changes: TrackChange[];
  threads: CommentThread[];
}

@Injectable()
export class GetDocReviewsUseCase {
  constructor(private readonly repository: ITrackChangesRepositoryPort) {}

  public async execute(projectId: string, docId: string): Promise<GetDocReviewsOutput> {
    const changes = await this.repository.listChangesByDoc(projectId, docId);
    const threads = await this.repository.listThreadsByDoc(projectId, docId);

    return {
      changes,
      threads,
    };
  }
}
