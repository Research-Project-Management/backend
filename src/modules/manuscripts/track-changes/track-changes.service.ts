/**
 * track-changes/track-changes.service.ts
 * Main Injectable Service orchestrating Track Changes & Comments use cases.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RecordChangeUseCase } from './core/use-cases/record-change.use-case';
import { AcceptChangeUseCase } from './core/use-cases/accept-change.use-case';
import { RejectChangeUseCase } from './core/use-cases/reject-change.use-case';
import { BatchResolveChangesUseCase, BatchAction } from './core/use-cases/batch-resolve-changes.use-case';
import { CreateCommentThreadUseCase } from './core/use-cases/create-comment-thread.use-case';
import { AddCommentReplyUseCase } from './core/use-cases/add-comment-reply.use-case';
import { ResolveCommentThreadUseCase } from './core/use-cases/resolve-comment-thread.use-case';
import { GetDocReviewsUseCase } from './core/use-cases/get-doc-reviews.use-case';

import { TrackChange } from './core/domain/entities/track-change.entity';
import { CommentThread } from './core/domain/entities/comment-thread.entity';
import { CommentReply } from './core/domain/entities/comment-reply.entity';

import {
  RecordChangeDto,
  CreateCommentThreadDto,
  AddCommentReplyDto,
  TrackChangeResponseDto,
  CommentThreadResponseDto,
  CommentReplyResponseDto,
  DocReviewsResponseDto,
} from './dto/track-changes.dto';

@Injectable()
export class TrackChangesService {
  private readonly logger = new Logger(TrackChangesService.name);

  constructor(
    private readonly recordChangeUseCase: RecordChangeUseCase,
    private readonly acceptChangeUseCase: AcceptChangeUseCase,
    private readonly rejectChangeUseCase: RejectChangeUseCase,
    private readonly batchResolveChangesUseCase: BatchResolveChangesUseCase,
    private readonly createCommentThreadUseCase: CreateCommentThreadUseCase,
    private readonly addCommentReplyUseCase: AddCommentReplyUseCase,
    private readonly resolveCommentThreadUseCase: ResolveCommentThreadUseCase,
    private readonly getDocReviewsUseCase: GetDocReviewsUseCase,
  ) {}

  public async recordChange(
    projectId: string,
    docId: string,
    dto: RecordChangeDto,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const change = await this.recordChangeUseCase.execute({
      projectId,
      docId,
      type: dto.type,
      text: dto.text,
      range: dto.range,
      userId,
    });
    return this.toChangeDto(change);
  }

  public async acceptChange(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const change = await this.acceptChangeUseCase.execute({
      projectId,
      docId,
      changeId,
      userId,
    });
    return this.toChangeDto(change);
  }

  public async rejectChange(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const change = await this.rejectChangeUseCase.execute({
      projectId,
      docId,
      changeId,
      userId,
    });
    return this.toChangeDto(change);
  }

  public async batchResolveChanges(
    projectId: string,
    docId: string,
    action: BatchAction,
    userId?: string | null,
  ): Promise<{ resolvedCount: number; action: BatchAction }> {
    return await this.batchResolveChangesUseCase.execute({
      projectId,
      docId,
      action,
      userId,
    });
  }

  public async createCommentThread(
    projectId: string,
    docId: string,
    dto: CreateCommentThreadDto,
    userId?: string | null,
  ): Promise<CommentThreadResponseDto> {
    const thread = await this.createCommentThreadUseCase.execute({
      projectId,
      docId,
      quote: dto.quote,
      range: dto.range,
      content: dto.content,
      userId,
    });
    return this.toThreadDto(thread);
  }

  public async addCommentReply(
    projectId: string,
    docId: string,
    threadId: string,
    dto: AddCommentReplyDto,
    userId?: string | null,
  ): Promise<CommentReplyResponseDto> {
    const reply = await this.addCommentReplyUseCase.execute({
      projectId,
      docId,
      threadId,
      content: dto.content,
      userId,
    });
    return this.toReplyDto(reply);
  }

  public async resolveCommentThread(
    projectId: string,
    docId: string,
    threadId: string,
    resolve: boolean,
    userId?: string | null,
  ): Promise<CommentThreadResponseDto> {
    const thread = await this.resolveCommentThreadUseCase.execute({
      projectId,
      docId,
      threadId,
      resolve,
      userId,
    });
    return this.toThreadDto(thread);
  }

  public async getDocReviews(projectId: string, docId: string): Promise<DocReviewsResponseDto> {
    const result = await this.getDocReviewsUseCase.execute(projectId, docId);
    return {
      changes: result.changes.map((c) => this.toChangeDto(c)),
      threads: result.threads.map((t) => this.toThreadDto(t)),
    };
  }

  public toChangeDto(change: TrackChange): TrackChangeResponseDto {
    return {
      id: change.id,
      projectId: change.projectId,
      docId: change.docId,
      type: change.type,
      status: change.status,
      text: change.text,
      range: change.range.toJSON() as any,
      createdById: change.createdById,
      resolvedById: change.resolvedById,
      resolvedAt: change.resolvedAt?.toISOString() ?? null,
      createdAt: change.createdAt.toISOString(),
      updatedAt: change.updatedAt.toISOString(),
    };
  }

  public toReplyDto(reply: CommentReply): CommentReplyResponseDto {
    return {
      id: reply.id,
      threadId: reply.threadId,
      content: reply.content,
      createdById: reply.createdById,
      createdAt: reply.createdAt.toISOString(),
      updatedAt: reply.updatedAt.toISOString(),
    };
  }

  public toThreadDto(thread: CommentThread): CommentThreadResponseDto {
    return {
      id: thread.id,
      projectId: thread.projectId,
      docId: thread.docId,
      quote: thread.quote,
      range: thread.range.toJSON() as any,
      isResolved: thread.isResolved,
      createdById: thread.createdById,
      resolvedById: thread.resolvedById,
      resolvedAt: thread.resolvedAt?.toISOString() ?? null,
      replies: thread.replies.map((r) => this.toReplyDto(r)),
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };
  }
}
