/**
 * track-changes/track-changes.service.ts
 * Deep Module Service orchestrating Track Changes & Comments directly via TrackChangesRepository
 * and pure domain LinePatcher, while preserving backward compatibility for legacy use-case tests.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ResourceAccessPolicy, Role } from '@/modules/project/access';
import {
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
} from '@/modules/pages/core';
import {
  LinePatcher,
  TrackChange,
  ChangeStatus,
  CommentThread,
  CommentReply,
  TextRangeVo,
  ChangeNotFoundException,
  ThreadNotFoundException,
  ResolvedThreadException,
  BatchAction,
} from './domain';
import { TrackChangesRepository } from './track-changes.repository';
import {
  DocstorePatcherAdapter,
  RealtimeNotifierAdapter,
} from './adapters/track-changes.adapters';

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
  private readonly docstorePatcher?: DocstorePatcherAdapter;

  constructor(
    private readonly repository: TrackChangesRepository,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() docstorePatcher?: DocstorePatcherAdapter,
    @Optional() private readonly realtimeNotifier?: RealtimeNotifierAdapter,
    @Optional() private readonly liveCollab?: LiveCollaborationPort,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
  ) {
    this.docstorePatcher =
      docstorePatcher ??
      (docstoreService
        ? new DocstorePatcherAdapter(
            docstoreService,
            this.liveCollab,
            this.domainEventBus,
            this.liveCollab,
          )
        : undefined);
  }

  public async resolveProjectId(
    projectId: string,
    docId: string,
  ): Promise<string> {
    if (projectId && projectId.trim()) {
      return projectId;
    }
    if (this.docstoreService && docId) {
      const doc = await this.docstoreService.getDocById(docId);
      if (doc?.projectId) return doc.projectId;
    }
    throw new NotFoundException(
      `Could not resolve project for document '${docId}'.`,
    );
  }

  private async resolveDocContext(
    projectId: string,
    docId: string,
  ): Promise<{ spaceId: string; pageId: string | null }> {
    const resolvedSpaceId = await this.resolveProjectId(projectId, docId);
    if (
      this.docstoreService &&
      typeof this.docstoreService.getDocById === 'function' &&
      docId
    ) {
      const doc = await this.docstoreService
        .getDocById(docId)
        .catch(() => undefined);
      if (doc === null) {
        throw new NotFoundException(`Document '${docId}' was not found.`);
      }
      if (doc) {
        if (doc.deleted) {
          throw new NotFoundException(`Document '${docId}' has been deleted.`);
        }
        if (
          doc.projectId &&
          doc.projectId !== resolvedSpaceId &&
          doc.pageId !== resolvedSpaceId
        ) {
          throw new NotFoundException(
            `Document '${docId}' was not found in space '${resolvedSpaceId}'.`,
          );
        }
        return {
          spaceId: doc.projectId || resolvedSpaceId,
          pageId: doc.pageId ?? null,
        };
      }
    }
    return { spaceId: resolvedSpaceId, pageId: null };
  }

  public async recordChange(
    projectId: string,
    docId: string,
    dto: RecordChangeDto,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const { spaceId: resolvedProjId, pageId } = await this.resolveDocContext(
      projectId,
      docId,
    );
    const range = dto.range || {
      startLine: dto.startLine ?? 0,
      startCol: dto.startCol ?? 0,
      endLine: dto.endLine ?? dto.startLine ?? 0,
      endCol: dto.endCol ?? 0,
    };

    const change = TrackChange.create({
      projectId: resolvedProjId,
      spaceId: resolvedProjId,
      pageId,
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

  public async acceptChange(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const { spaceId: resolvedProjId } = await this.resolveDocContext(
      projectId,
      docId,
    );
    const saved = await this.acceptChangeDirect(
      resolvedProjId,
      docId,
      changeId,
      userId,
    );
    return this.toChangeDto(saved);
  }

  public async rejectChange(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChangeResponseDto> {
    const { spaceId: resolvedProjId } = await this.resolveDocContext(
      projectId,
      docId,
    );
    const saved = await this.rejectChangeDirect(
      resolvedProjId,
      docId,
      changeId,
      userId,
    );
    return this.toChangeDto(saved);
  }

  public async batchResolveChanges(
    projectId: string,
    docId: string,
    action: BatchAction,
    changeIds?: string[],
    userId?: string | null,
  ): Promise<{ resolvedCount: number; action: BatchAction }> {
    const { spaceId: resolvedProjId } = await this.resolveDocContext(
      projectId,
      docId,
    );

    const pendingChanges = await this.repository.listChangesByDoc(
      resolvedProjId,
      docId,
      'pending',
    );
    const filtered =
      changeIds && changeIds.length > 0
        ? pendingChanges.filter((c) => changeIds.includes(c.id))
        : pendingChanges;

    if (filtered.length === 0) {
      return { resolvedCount: 0, action };
    }

    const isAccept = action === 'accept_all' || action === 'accept_selected';
    const resolvedStatus: ChangeStatus = isAccept ? 'accepted' : 'rejected';
    const now = new Date();

    if (typeof this.repository.claimPendingChanges === 'function') {
      const candidateIds = filtered.map((c) => c.id);
      const claimedIds = await this.repository.claimPendingChanges(
        resolvedProjId,
        docId,
        candidateIds,
        resolvedStatus,
        userId ?? null,
        now,
      );
      if (claimedIds.length === 0) {
        return { resolvedCount: 0, action };
      }

      const claimedSet = new Set(claimedIds);
      const sorted = LinePatcher.sortChangesBottomUp(
        filtered.filter((c) => claimedSet.has(c.id)),
      );

      try {
        if (sorted.length > 0 && this.docstorePatcher) {
          await this.docstorePatcher.applyBatchChanges(
            resolvedProjId,
            docId,
            sorted,
            isAccept,
          );
        }
      } catch (err) {
        await this.repository
          .revertClaimedChangesStatus?.(
            resolvedProjId,
            docId,
            claimedIds,
            resolvedStatus,
          )
          .catch(() => undefined);
        throw err;
      }

      for (const change of sorted) {
        if (isAccept) {
          change.accept(userId);
        } else {
          change.reject(userId);
        }
        this.realtimeNotifier?.notifyChangeResolved(
          resolvedProjId,
          docId,
          change,
        );
      }

      return {
        resolvedCount: sorted.length,
        action,
      };
    }

    const sorted = LinePatcher.sortChangesBottomUp(filtered);

    if (sorted.length > 0 && this.docstorePatcher) {
      await this.docstorePatcher.applyBatchChanges(
        resolvedProjId,
        docId,
        sorted,
        isAccept,
      );
    }

    const idsToUpdate = sorted.map((c) => c.id);

    for (const change of sorted) {
      if (isAccept) {
        change.accept(userId);
      } else {
        change.reject(userId);
      }
    }

    // Atomic O(1) DB batch update instead of sequential N+1 updates
    await this.repository.batchUpdateChangesStatus(
      idsToUpdate,
      resolvedStatus,
      userId,
      now,
      resolvedProjId,
      docId,
    );

    for (const change of sorted) {
      this.realtimeNotifier?.notifyChangeResolved(
        resolvedProjId,
        docId,
        change,
      );
    }

    return {
      resolvedCount: sorted.length,
      action,
    };
  }

  public async createCommentThread(
    projectId: string,
    docId: string,
    dto: CreateCommentThreadDto,
    userId?: string | null,
  ): Promise<CommentThreadResponseDto> {
    const { spaceId: resolvedProjId, pageId } = await this.resolveDocContext(
      projectId,
      docId,
    );
    const range = dto.range || {
      startLine: dto.startLine ?? 0,
      startCol: dto.startCol ?? dto.fromIndex ?? 0,
      endLine: dto.endLine ?? dto.startLine ?? 0,
      endCol: dto.endCol ?? dto.toIndex ?? 0,
    };

    const thread = CommentThread.create({
      projectId: resolvedProjId,
      spaceId: resolvedProjId,
      pageId,
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

  public async addCommentReply(
    projectId: string,
    docId: string,
    threadId: string,
    dto: AddCommentReplyDto,
    userId?: string | null,
  ): Promise<CommentReplyResponseDto> {
    const resolved = await this.resolveDocContext(projectId, docId);
    const resolvedProjId = resolved.spaceId;

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

  public async updateCommentReply(
    projectId: string,
    docId: string,
    threadId: string,
    replyId: string,
    content: string,
    userId?: string | null,
    role?: Role,
    permissionBitmask?: string,
  ): Promise<CommentReplyResponseDto> {
    const resolved = await this.resolveDocContext(projectId, docId);
    const resolvedProjId = resolved.spaceId;

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

    const existingReply = thread.replies.find((r) => r.id === replyId);
    if (!existingReply) {
      throw new NotFoundException(`Comment reply '${replyId}' was not found.`);
    }

    if (existingReply.createdById) {
      new ResourceAccessPolicy().assertCanModifyComment(
        {
          userId: userId ?? '',
          role: role ?? Role.REVIEWER,
          permissionBitmask,
        },
        { id: replyId, authorId: existingReply.createdById },
        'update',
      );
    }

    const validated = CommentReply.create({
      id: replyId,
      threadId,
      content,
      createdById: existingReply.createdById,
    });
    const updated = await this.repository.updateCommentReply?.(
      threadId,
      replyId,
      validated.content,
    );
    if (!updated) {
      throw new NotFoundException(`Comment reply '${replyId}' was not found.`);
    }
    return this.toReplyDto(updated);
  }

  public async resolveCommentThread(
    projectId: string,
    docId: string,
    threadId: string,
    resolve: boolean,
    userId?: string | null,
  ): Promise<CommentThreadResponseDto> {
    const resolved = await this.resolveDocContext(projectId, docId);
    const resolvedProjId = resolved.spaceId;

    const thread = await this.repository.findThreadById(threadId);
    if (
      !thread ||
      thread.projectId !== resolvedProjId ||
      thread.docId !== docId
    ) {
      throw new ThreadNotFoundException(threadId);
    }

    if (thread.isResolved === resolve) {
      return this.toThreadDto(thread);
    }

    if (resolve) {
      thread.resolve(userId);
    } else {
      thread.unresolve();
    }

    const saved = await this.repository.saveCommentThread(thread);
    this.realtimeNotifier?.notifyCommentResolved(resolvedProjId, docId, saved);
    return this.toThreadDto(saved);
  }

  public async getDocReviews(
    projectId: string,
    docId: string,
  ): Promise<DocReviewsResponseDto> {
    const resolved = await this.resolveDocContext(projectId, docId);
    const resolvedProjId = resolved.spaceId;

    const [changes, threads] = await Promise.all([
      this.repository.listChangesByDoc(resolvedProjId, docId),
      this.repository.listThreadsByDoc(resolvedProjId, docId),
    ]);
    return {
      changes: changes.map((c) => this.toChangeDto(c)),
      threads: threads.map((t) => this.toThreadDto(t)),
    };
  }

  private async acceptChangeDirect(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChange> {
    const change = await this.repository.findChangeById(changeId);
    if (!change || change.projectId !== projectId || change.docId !== docId) {
      throw new ChangeNotFoundException(changeId);
    }

    if (change.status !== 'pending') {
      return change;
    }

    if (typeof this.repository.claimPendingChanges === 'function') {
      const claimed = await this.repository.claimPendingChanges(
        projectId,
        docId,
        [changeId],
        'accepted',
        userId ?? null,
      );
      if (claimed.length === 0) {
        const latest = await this.repository.findChangeById(changeId);
        if (!latest) throw new ChangeNotFoundException(changeId);
        return latest;
      }

      change.accept(userId);

      try {
        if (this.docstorePatcher) {
          await this.docstorePatcher.applyChange(projectId, docId, change);
        }
        const saved =
          (await this.repository.findChangeById(changeId)) ?? change;
        this.realtimeNotifier?.notifyChangeResolved(projectId, docId, saved);
        return saved;
      } catch (err) {
        await this.repository
          .revertClaimedChangesStatus?.(
            projectId,
            docId,
            [changeId],
            'accepted',
          )
          .catch(() => undefined);
        change.reopen();
        throw err;
      }
    }

    change.accept(userId);

    if (this.docstorePatcher) {
      await this.docstorePatcher.applyChange(projectId, docId, change);
    }

    try {
      const saved = await this.repository.saveChange(change);
      this.realtimeNotifier?.notifyChangeResolved(projectId, docId, saved);
      return saved;
    } catch (err) {
      if (this.docstorePatcher) {
        await this.docstorePatcher
          .revertChange(projectId, docId, change)
          .catch(() => undefined);
      }
      change.reopen();
      throw err;
    }
  }

  private async rejectChangeDirect(
    projectId: string,
    docId: string,
    changeId: string,
    userId?: string | null,
  ): Promise<TrackChange> {
    const change = await this.repository.findChangeById(changeId);
    if (!change || change.projectId !== projectId || change.docId !== docId) {
      throw new ChangeNotFoundException(changeId);
    }

    if (change.status !== 'pending') {
      return change;
    }

    if (typeof this.repository.claimPendingChanges === 'function') {
      const claimed = await this.repository.claimPendingChanges(
        projectId,
        docId,
        [changeId],
        'rejected',
        userId ?? null,
      );
      if (claimed.length === 0) {
        const latest = await this.repository.findChangeById(changeId);
        if (!latest) throw new ChangeNotFoundException(changeId);
        return latest;
      }

      change.reject(userId);

      try {
        if (this.docstorePatcher) {
          await this.docstorePatcher.revertChange(projectId, docId, change);
        }
        const saved =
          (await this.repository.findChangeById(changeId)) ?? change;
        this.realtimeNotifier?.notifyChangeResolved(projectId, docId, saved);
        return saved;
      } catch (err) {
        await this.repository
          .revertClaimedChangesStatus?.(
            projectId,
            docId,
            [changeId],
            'rejected',
          )
          .catch(() => undefined);
        change.reopen();
        throw err;
      }
    }

    change.reject(userId);

    if (this.docstorePatcher) {
      await this.docstorePatcher.revertChange(projectId, docId, change);
    }

    try {
      const saved = await this.repository.saveChange(change);
      this.realtimeNotifier?.notifyChangeResolved(projectId, docId, saved);
      return saved;
    } catch (err) {
      if (this.docstorePatcher) {
        await this.docstorePatcher
          .applyChange(projectId, docId, change)
          .catch(() => undefined);
      }
      change.reopen();
      throw err;
    }
  }

  public toChangeDto(change: TrackChange): TrackChangeResponseDto {
    return {
      id: change.id,
      projectId: change.projectId,
      spaceId: change.spaceId,
      pageId: change.pageId,
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
      spaceId: thread.spaceId,
      pageId: thread.pageId,
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
