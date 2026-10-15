/**
 * track-changes/track-changes.service.ts
 * Deep Module Service orchestrating Track Changes & Comments directly via TrackChangesRepository
 * and pure domain LinePatcher, while preserving backward compatibility for legacy use-case tests.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { TrackChangesRepository } from './track-changes.repository';
import {
  LinePatcher,
  TrackChange,
  CommentThread,
  CommentReply,
  TextRangeVo,
  ChangeNotFoundException,
  ThreadNotFoundException,
  ResolvedThreadException,
} from './domain';
import { DocstorePatcherAdapter } from './core/adapters/external/docstore-patcher.adapter';
import { RealtimeNotifierAdapter } from './core/adapters/external/realtime-notifier.adapter';

import { RecordChangeUseCase } from './core/use-cases/record-change.use-case';
import { AcceptChangeUseCase } from './core/use-cases/accept-change.use-case';
import { RejectChangeUseCase } from './core/use-cases/reject-change.use-case';
import {
  BatchResolveChangesUseCase,
  BatchAction,
} from './core/use-cases/batch-resolve-changes.use-case';
import { CreateCommentThreadUseCase } from './core/use-cases/create-comment-thread.use-case';
import { AddCommentReplyUseCase } from './core/use-cases/add-comment-reply.use-case';
import { ResolveCommentThreadUseCase } from './core/use-cases/resolve-comment-thread.use-case';
import { GetDocReviewsUseCase } from './core/use-cases/get-doc-reviews.use-case';

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
    @Optional() private readonly recordChangeUseCase?: RecordChangeUseCase,
    @Optional() private readonly acceptChangeUseCase?: AcceptChangeUseCase,
    @Optional() private readonly rejectChangeUseCase?: RejectChangeUseCase,
    @Optional()
    private readonly batchResolveChangesUseCase?: BatchResolveChangesUseCase,
    @Optional()
    private readonly createCommentThreadUseCase?: CreateCommentThreadUseCase,
    @Optional()
    private readonly addCommentReplyUseCase?: AddCommentReplyUseCase,
    @Optional()
    private readonly resolveCommentThreadUseCase?: ResolveCommentThreadUseCase,
    @Optional() private readonly getDocReviewsUseCase?: GetDocReviewsUseCase,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly repository?: TrackChangesRepository,
    @Optional() private readonly docstorePatcher?: DocstorePatcherAdapter,
    @Optional() private readonly realtimeNotifier?: RealtimeNotifierAdapter,
  ) {}

  public async resolveProjectId(
    projectId: string,
    docId: string,
  ): Promise<string> {
    const isSpecial =
      !projectId ||
      projectId === 'default' ||
      projectId === 'personal' ||
      projectId === 'me';
    if (this.docstoreService && isSpecial && docId) {
      try {
        const doc = await this.docstoreService.getDocById(docId);
        if (doc?.projectId) return doc.projectId;
      } catch {
        // Fallback
      }
    }
    return projectId || 'default';
  }

  public async recordChange(
    projectId: string,
    docId: string,
    dto: RecordChangeDto,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const resolvedProjId = await this.resolveProjectId(projectId, docId);
    const range = dto.range || {
      startLine: dto.startLine ?? 0,
      startCol: dto.startCol ?? dto.fromIndex ?? 0,
      endLine: dto.endLine ?? dto.startLine ?? 0,
      endCol: dto.endCol ?? dto.toIndex ?? 0,
    };

    if (this.repository) {
      const change = TrackChange.create({
        projectId: resolvedProjId,
        docId,
        type: dto.type,
        text: dto.text,
        range: TextRangeVo.create(range),
        createdById: userId,
      });
      const saved = await this.repository.saveChange(change);
      this.realtimeNotifier?.notifyChangeRecorded(resolvedProjId, docId, saved);
      return this.toChangeDto(saved);
    }

    const change = await this.recordChangeUseCase!.execute({
      projectId: resolvedProjId,
      docId,
      type: dto.type,
      text: dto.text,
      range,
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
    const resolvedProjId = await this.resolveProjectId(projectId, docId);

    if (this.repository) {
      const saved = await this.acceptChangeDirect(
        resolvedProjId,
        docId,
        changeId,
        userId,
      );
      return this.toChangeDto(saved);
    }

    const change = await this.acceptChangeUseCase!.execute({
      projectId: resolvedProjId,
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
    const resolvedProjId = await this.resolveProjectId(projectId, docId);

    if (this.repository) {
      const saved = await this.rejectChangeDirect(
        resolvedProjId,
        docId,
        changeId,
        userId,
      );
      return this.toChangeDto(saved);
    }

    const change = await this.rejectChangeUseCase!.execute({
      projectId: resolvedProjId,
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
    changeIds?: string[],
    userId?: string | null,
  ): Promise<{ resolvedCount: number; action: BatchAction }> {
    const resolvedProjId = await this.resolveProjectId(projectId, docId);

    if (this.repository) {
      const pendingChanges = await this.repository.listChangesByDoc(
        resolvedProjId,
        docId,
        'pending',
      );
      const filtered =
        changeIds && changeIds.length > 0
          ? pendingChanges.filter((c) => changeIds.includes(c.id))
          : pendingChanges;

      const sorted = LinePatcher.sortChangesBottomUp(filtered);
      const isAccept = action === 'accept_all' || action === 'accept_selected';

      for (const change of sorted) {
        if (isAccept) {
          await this.acceptChangeDirect(
            resolvedProjId,
            docId,
            change.id,
            userId,
          );
        } else {
          await this.rejectChangeDirect(
            resolvedProjId,
            docId,
            change.id,
            userId,
          );
        }
      }

      return {
        resolvedCount: sorted.length,
        action,
      };
    }

    return await this.batchResolveChangesUseCase!.execute({
      projectId: resolvedProjId,
      docId,
      action,
      changeIds,
      userId,
    });
  }

  public async createCommentThread(
    projectId: string,
    docId: string,
    dto: CreateCommentThreadDto,
    userId?: string | null,
  ): Promise<CommentThreadResponseDto> {
    const resolvedProjId = await this.resolveProjectId(projectId, docId);
    const range = dto.range || {
      startLine: dto.startLine ?? 0,
      startCol: dto.startCol ?? dto.fromIndex ?? 0,
      endLine: dto.endLine ?? dto.startLine ?? 0,
      endCol: dto.endCol ?? dto.toIndex ?? 0,
    };

    if (this.repository) {
      const thread = CommentThread.create({
        projectId: resolvedProjId,
        docId,
        quote: dto.quote,
        range: TextRangeVo.create(range),
        createdById: userId,
      });

      if (dto.content && dto.content.trim()) {
        const initialReply = CommentReply.create({
          threadId: thread.id,
          content: dto.content.trim(),
          createdById: userId,
        });
        thread.addReply(initialReply);
      }

      const saved = await this.repository.saveCommentThread(thread);
      this.realtimeNotifier?.notifyCommentCreated(resolvedProjId, docId, saved);
      return this.toThreadDto(saved);
    }

    const thread = await this.createCommentThreadUseCase!.execute({
      projectId: resolvedProjId,
      docId,
      quote: dto.quote,
      range,
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
    const resolvedProjId = await this.resolveProjectId(projectId, docId);

    if (this.repository) {
      const thread = await this.repository.findThreadById(threadId);
      if (
        !thread ||
        thread.projectId !== resolvedProjId ||
        thread.docId !== docId
      ) {
        throw new ThreadNotFoundException(threadId);
      }
      if (thread.isResolved) {
        throw new ResolvedThreadException(threadId);
      }

      const reply = CommentReply.create({
        threadId,
        content: dto.content,
        createdById: userId,
      });
      const saved = await this.repository.addCommentReply(threadId, reply);
      this.realtimeNotifier?.notifyCommentReplied(
        resolvedProjId,
        docId,
        threadId,
        saved,
        thread.createdById,
      );
      return this.toReplyDto(saved);
    }

    const reply = await this.addCommentReplyUseCase!.execute({
      projectId: resolvedProjId,
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
    const resolvedProjId = await this.resolveProjectId(projectId, docId);

    if (this.repository) {
      const thread = await this.repository.findThreadById(threadId);
      if (
        !thread ||
        thread.projectId !== resolvedProjId ||
        thread.docId !== docId
      ) {
        throw new ThreadNotFoundException(threadId);
      }

      if (resolve) {
        thread.resolve(userId);
      } else {
        thread.unresolve();
      }

      const saved = await this.repository.saveCommentThread(thread);
      this.realtimeNotifier?.notifyCommentResolved(
        resolvedProjId,
        docId,
        saved,
      );
      return this.toThreadDto(saved);
    }

    const thread = await this.resolveCommentThreadUseCase!.execute({
      projectId: resolvedProjId,
      docId,
      threadId,
      resolve,
      userId,
    });
    return this.toThreadDto(thread);
  }

  public async getDocReviews(
    projectId: string,
    docId: string,
  ): Promise<DocReviewsResponseDto> {
    const resolvedProjId = await this.resolveProjectId(projectId, docId);

    if (this.repository) {
      const [changes, threads] = await Promise.all([
        this.repository.listChangesByDoc(resolvedProjId, docId),
        this.repository.listThreadsByDoc(resolvedProjId, docId),
      ]);
      return {
        changes: changes.map((c) => this.toChangeDto(c)),
        threads: threads.map((t) => this.toThreadDto(t)),
      };
    }

    const result = await this.getDocReviewsUseCase!.execute(
      resolvedProjId,
      docId,
    );
    return {
      changes: result.changes.map((c) => this.toChangeDto(c)),
      threads: result.threads.map((t) => this.toThreadDto(t)),
    };
  }

  private async acceptChangeDirect(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChange> {
    const change = await this.repository!.findChangeById(changeId);
    if (!change || change.projectId !== projectId || change.docId !== docId) {
      throw new ChangeNotFoundException(changeId);
    }

    change.accept(userId);

    if (this.docstorePatcher) {
      await this.docstorePatcher.applyChange(projectId, docId, change);
    } else if (this.docstoreService) {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      const { lines, mutated } = LinePatcher.computeAcceptedPatch(
        doc.lines,
        change,
      );
      if (mutated) {
        await this.docstoreService.updateDoc(projectId, docId, {
          lines,
          version: doc.version,
        });
      }
    }

    const saved = await this.repository!.saveChange(change);
    this.realtimeNotifier?.notifyChangeResolved(projectId, docId, saved);
    return saved;
  }

  private async rejectChangeDirect(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChange> {
    const change = await this.repository!.findChangeById(changeId);
    if (!change || change.projectId !== projectId || change.docId !== docId) {
      throw new ChangeNotFoundException(changeId);
    }

    change.reject(userId);

    if (this.docstorePatcher) {
      await this.docstorePatcher.revertChange(projectId, docId, change);
    } else if (this.docstoreService) {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      const { lines } = LinePatcher.computeRejectedPatch(doc.lines, change);
      await this.docstoreService.updateDoc(projectId, docId, {
        lines,
        version: doc.version,
      });
    }

    const saved = await this.repository!.saveChange(change);
    this.realtimeNotifier?.notifyChangeResolved(projectId, docId, saved);
    return saved;
  }

  public toChangeDto(change: TrackChange): TrackChangeResponseDto {
    return {
      id: change.id,
      projectId: change.projectId,
      docId: change.docId,
      type: change.type,
      status: change.status,
      text: change.text,
      range: change.range.toJSON(),
      createdById: change.createdById,
      authorId: change.createdById,
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
      authorId: reply.createdById,
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
      selectedText: thread.quote,
      content: thread.replies[0]?.content ?? thread.quote ?? '',
      range: thread.range.toJSON(),
      isResolved: thread.isResolved,
      resolved: thread.isResolved,
      createdById: thread.createdById,
      authorId: thread.createdById,
      resolvedById: thread.resolvedById,
      resolvedAt: thread.resolvedAt?.toISOString() ?? null,
      replies: thread.replies.map((r) => this.toReplyDto(r)),
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };
  }
}
