import { Injectable } from '@nestjs/common';
import { Prisma, ReviewStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '@/core';
import { ChangeStatus, TrackChange } from './domain/change.domain';
import { CommentReply, CommentThread } from './domain/comment.domain';
import {
  ReviewMapper,
  extractMentionUserIds,
  toPrismaBytes,
  type ChangeWithDoc,
  type DocReviewWithRound,
  type ThreadWithReplies,
} from './domain/review.mapper';

@Injectable()
export class ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  public getPrisma(): PrismaService {
    return this.prisma;
  }

  private async syncMentions(replyId: string, content: string): Promise<void> {
    if (!this.prisma.commentMention?.createMany) return;
    const userIds = extractMentionUserIds(content);
    if (this.prisma.commentMention.deleteMany) {
      await this.prisma.commentMention.deleteMany({ where: { replyId } });
    }
    if (userIds.length > 0) {
      await this.prisma.commentMention.createMany({
        data: userIds.map((userId) => ({ replyId, userId })),
        skipDuplicates: true,
      });
    }
  }

  // ── Document Changes (Suggestions / Track Changes) ─────────────────────────

  public async saveChange(change: TrackChange): Promise<TrackChange> {
    const { range } = change;
    const record = await this.prisma.docChange.upsert({
      where: { id: change.id },
      create: {
        id: change.id,
        docId: change.docId,
        groupId: change.groupId,
        type: change.type,
        status: change.status,
        text: change.text,
        startLine: range.startLine,
        startCol: range.startCol,
        endLine: range.endLine,
        endCol: range.endCol,
        anchorStart: toPrismaBytes(change.anchorStart),
        anchorEnd: toPrismaBytes(change.anchorEnd),
        baseDocRev: change.baseDocRev,
        createdById: change.createdById,
        resolvedById: change.resolvedById,
        resolvedAt: change.resolvedAt,
        createdAt: change.createdAt,
        updatedAt: change.updatedAt,
      },
      update: {
        status: change.status,
        resolvedById: change.resolvedById,
        resolvedAt: change.resolvedAt,
        updatedAt: change.updatedAt,
      },
      include: { doc: { select: { spaceId: true, pageId: true } } },
    });
    return ReviewMapper.toDomainChange(record, change.spaceId, change.pageId);
  }

  public async findChange(
    spaceId: string,
    changeId: string,
    docId?: string,
  ): Promise<ChangeWithDoc | null> {
    if (!isUUID(changeId)) return null;
    return this.prisma.docChange.findFirst({
      where: {
        id: changeId,
        doc: { spaceId },
        ...(docId && isUUID(docId) ? { docId } : {}),
      },
      include: { doc: { select: { spaceId: true, pageId: true } } },
    });
  }

  public async listChanges(
    spaceId: string,
    docId: string,
    status?: ChangeStatus,
  ): Promise<TrackChange[]> {
    const where: Prisma.DocChangeWhereInput = { docId, doc: { spaceId } };
    if (status) where.status = status;

    const records = await this.prisma.docChange.findMany({
      where,
      include: { doc: { select: { spaceId: true, pageId: true } } },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return records.map((r) => ReviewMapper.toDomainChange(r, spaceId));
  }

  public async findPendingChangesByGroup(
    spaceId: string,
    docId: string,
    groupId: string,
  ): Promise<TrackChange[]> {
    if (!isUUID(groupId) || !this.prisma.docChange?.findMany) return [];
    const records = await Promise.resolve(
      this.prisma.docChange.findMany({
        where: {
          docId,
          groupId,
          status: 'pending',
          doc: { spaceId },
        },
        include: { doc: { select: { spaceId: true, pageId: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ).catch(() => []);
    return Array.isArray(records)
      ? records.map((r) => ReviewMapper.toDomainChange(r, spaceId))
      : [];
  }

  public async updateChange(
    spaceId: string,
    changeId: string,
    data: Prisma.DocChangeUpdateManyMutationInput,
  ): Promise<boolean> {
    const res = await this.prisma.docChange.updateMany({
      where: { id: changeId, doc: { spaceId } },
      data,
    });
    return res.count > 0;
  }

  public async claimPendingChanges(
    spaceId: string,
    changeIds: string[],
    nextStatus: 'accepted' | 'rejected',
    resolvedById: string | null,
    docId?: string,
  ): Promise<string[]> {
    const uniqueIds = Array.from(new Set(changeIds.filter((id) => isUUID(id))));
    if (uniqueIds.length === 0) return [];
    const resolvedAt = new Date();

    const runClaim = async (
      db: Pick<PrismaService, 'docChange'>,
    ): Promise<string[]> => {
      const claimed: string[] = [];
      for (const id of uniqueIds) {
        const res = await db.docChange.updateMany({
          where: {
            id,
            status: 'pending',
            doc: { spaceId },
            ...(docId && isUUID(docId) ? { docId } : {}),
          },
          data: {
            status: nextStatus,
            resolvedAt,
            resolvedById,
            version: { increment: 1 },
            updatedAt: resolvedAt,
          },
        });
        if (res.count === 1) claimed.push(id);
      }
      return claimed;
    };

    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(async (tx) => {
        const client = tx?.docChange ? tx : this.prisma;
        return runClaim(client);
      });
    }
    return runClaim(this.prisma);
  }

  public async revertClaimedChanges(
    spaceId: string,
    changeIds: string[],
    expectedStatus: 'accepted' | 'rejected',
  ): Promise<void> {
    if (changeIds.length === 0) return;
    await this.prisma.docChange.updateMany({
      where: {
        id: { in: changeIds },
        status: expectedStatus,
        doc: { spaceId },
      },
      data: {
        status: 'pending',
        resolvedAt: null,
        resolvedById: null,
        updatedAt: new Date(),
      },
    });
  }

  // ── Comments, Replies & Mentions ───────────────────────────────────────────

  public async saveThread(thread: CommentThread): Promise<CommentThread> {
    const { range } = thread;
    const record = await this.prisma.docComment.upsert({
      where: { id: thread.id },
      create: {
        id: thread.id,
        docId: thread.docId,
        quote: thread.quote,
        startLine: range.startLine,
        startCol: range.startCol,
        endLine: range.endLine,
        endCol: range.endCol,
        anchorStart: toPrismaBytes(thread.anchorStart),
        anchorEnd: toPrismaBytes(thread.anchorEnd),
        baseDocRev: thread.baseDocRev,
        isResolved: thread.isResolved,
        createdById: thread.createdById,
        resolvedById: thread.resolvedById,
        resolvedAt: thread.resolvedAt,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        replies:
          thread.replies.length > 0
            ? {
                create: thread.replies.map((r) => ({
                  id: r.id,
                  content: r.content,
                  createdById: r.createdById,
                  createdAt: r.createdAt,
                  updatedAt: r.updatedAt,
                })),
              }
            : undefined,
      },
      update: {
        isResolved: thread.isResolved,
        resolvedById: thread.resolvedById,
        resolvedAt: thread.resolvedAt,
        updatedAt: thread.updatedAt,
      },
      include: {
        doc: { select: { spaceId: true, pageId: true } },
        replies: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    for (const r of thread.replies) {
      await this.syncMentions(r.id, r.content).catch(() => undefined);
    }
    return ReviewMapper.toDomainThread(record, thread.spaceId, thread.pageId);
  }

  public async findThread(
    spaceId: string,
    threadId: string,
    docId?: string,
  ): Promise<ThreadWithReplies | null> {
    if (!isUUID(threadId)) return null;
    return this.prisma.docComment.findFirst({
      where: {
        id: threadId,
        deletedAt: null,
        doc: { spaceId },
        ...(docId && isUUID(docId) ? { docId } : {}),
      },
      include: {
        doc: { select: { spaceId: true, pageId: true } },
        replies: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  public async listThreads(
    spaceId: string,
    docId: string,
    isResolved?: boolean,
  ): Promise<CommentThread[]> {
    const where: Prisma.DocCommentWhereInput = {
      docId,
      deletedAt: null,
      doc: { spaceId },
    };
    if (isResolved !== undefined) where.isResolved = isResolved;

    const records = await this.prisma.docComment.findMany({
      where,
      include: {
        doc: { select: { spaceId: true, pageId: true } },
        replies: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return records.map((r) => ReviewMapper.toDomainThread(r, spaceId));
  }

  public async listThreadsPaginated(
    spaceId: string,
    docId: string,
    options: {
      isResolved?: boolean;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{
    items: CommentThread[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const clampedLimit = Math.min(Math.max(1, options.limit ?? 20), 100);
    const where: Prisma.DocCommentWhereInput = {
      docId,
      deletedAt: null,
      doc: { spaceId },
    };
    if (options.isResolved !== undefined) {
      where.isResolved = options.isResolved;
    }

    const validCursor =
      options.cursor && isUUID(options.cursor) ? options.cursor : undefined;

    const records = await this.prisma.docComment.findMany({
      where,
      include: {
        doc: { select: { spaceId: true, pageId: true } },
        replies: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(validCursor ? { cursor: { id: validCursor }, skip: 1 } : {}),
      take: clampedLimit + 1,
    });

    const hasMore = records.length > clampedLimit;
    const pageRecords = hasMore ? records.slice(0, clampedLimit) : records;
    const nextCursor =
      hasMore && pageRecords.length > 0
        ? pageRecords[pageRecords.length - 1].id
        : null;

    return {
      items: pageRecords.map((r) => ReviewMapper.toDomainThread(r, spaceId)),
      nextCursor,
      hasMore,
    };
  }

  public async updateThread(
    spaceId: string,
    commentId: string,
    data: Prisma.DocCommentUpdateManyMutationInput,
  ): Promise<boolean> {
    const res = await this.prisma.docComment.updateMany({
      where: { id: commentId, deletedAt: null, doc: { spaceId } },
      data: { ...data, version: { increment: 1 } },
    });
    return res.count > 0;
  }

  public async deleteThread(
    spaceId: string,
    commentId: string,
    deletedById?: string | null,
  ): Promise<boolean> {
    const res = await this.prisma.docComment.updateMany({
      where: { id: commentId, deletedAt: null, doc: { spaceId } },
      data: {
        deletedAt: new Date(),
        ...(deletedById && isUUID(deletedById) ? { deletedById } : {}),
      },
    });
    if (res.count > 0 && this.prisma.commentMention?.deleteMany) {
      await this.prisma.commentMention
        .deleteMany({ where: { reply: { commentId } } })
        .catch(() => undefined);
    }
    return res.count > 0;
  }

  public async addReply(
    commentId: string,
    reply: CommentReply,
  ): Promise<CommentReply> {
    const record = await this.prisma.commentReply.create({
      data: {
        id: reply.id,
        commentId,
        content: reply.content,
        createdById: reply.createdById,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
      },
    });
    await this.syncMentions(record.id, reply.content).catch(() => undefined);
    return ReviewMapper.toDomainReply(record);
  }

  public async updateReply(
    commentId: string,
    replyId: string,
    content: string,
    updatedById?: string | null,
  ): Promise<boolean> {
    if (!isUUID(commentId) || !isUUID(replyId)) return false;
    const trimmed = content.trim();
    const res = await this.prisma.commentReply.updateMany({
      where: { id: replyId, commentId, deletedAt: null },
      data: {
        content: trimmed,
        ...(updatedById && isUUID(updatedById) ? { updatedById } : {}),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    if (res.count > 0) {
      await this.syncMentions(replyId, trimmed).catch(() => undefined);
      return true;
    }
    return false;
  }

  public async deleteReply(
    commentId: string,
    replyId: string,
    deletedById?: string | null,
  ): Promise<boolean> {
    if (!isUUID(commentId) || !isUUID(replyId)) return false;
    const res = await this.prisma.commentReply.updateMany({
      where: { id: replyId, commentId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        ...(deletedById && isUUID(deletedById) ? { deletedById } : {}),
      },
    });
    if (res.count > 0 && this.prisma.commentMention?.deleteMany) {
      await this.prisma.commentMention
        .deleteMany({ where: { replyId } })
        .catch(() => undefined);
    }
    return res.count > 0;
  }

  // ── Overview, DocReview & ReviewRound ──────────────────────────────────────

  public async getOverviewData(spaceId: string, explicitPageId?: string) {
    let targetSpaceId = spaceId;
    let targetPageId: string | undefined =
      explicitPageId && isUUID(explicitPageId) ? explicitPageId : undefined;

    if (this.prisma.page?.findUnique) {
      const page = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: spaceId },
          select: { id: true, spaceId: true },
        }),
      ).catch(() => null);
      const resolvedSpaceId =
        page?.spaceId ?? (page as { projectId?: string } | null)?.projectId;
      if (resolvedSpaceId) {
        targetSpaceId = resolvedSpaceId;
        if (!targetPageId && page?.id) targetPageId = page.id;
      }
    }

    const pageFilter = targetPageId ? { pageId: targetPageId } : {};
    const docScopeWhere = {
      spaceId: targetSpaceId,
      ...pageFilter,
      deletedAt: null,
    };

    const [docs, nodes, allThreads, allChanges] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: docScopeWhere,
        select: { id: true, lastKnownPath: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.pageNode.findMany({
        where: { spaceId: targetSpaceId, ...pageFilter, type: 'DOC' },
        select: {
          id: true,
          docId: true,
          name: true,
          path: true,
          sortOrder: true,
          page: { select: { rootDocId: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.docComment.findMany({
        where: { deletedAt: null, doc: docScopeWhere },
        include: {
          replies: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ startLine: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.docChange.findMany({
        where: { doc: docScopeWhere },
        orderBy: [
          { startLine: 'asc' },
          { startCol: 'asc' },
          { createdAt: 'asc' },
        ],
      }),
    ]);

    return { docs, nodes, allThreads, allChanges };
  }

  public async findDocReview(
    docId: string,
  ): Promise<DocReviewWithRound | null> {
    if (!this.prisma.docReview?.findUnique) return null;
    return Promise.resolve(
      this.prisma.docReview.findUnique({
        where: { docId },
        include: {
          doc: { select: { spaceId: true } },
          rounds: { orderBy: { roundNumber: 'desc' }, take: 1 },
        },
      }),
    ).catch(() => null);
  }

  public async updateDocReviewCas(
    docId: string,
    spaceId: string,
    expectedVersion: number,
    data: {
      status: ReviewStatus;
      roundNumber: number;
      requestedById: string | null;
      requestedAt: Date | null;
      verdictById: string | null;
      verdictAt: Date | null;
      notes: string | null;
      deadline: Date | null;
    },
  ): Promise<boolean> {
    if (!this.prisma.docReview?.updateMany) return true;

    const applyUpdate = async (
      db: Pick<PrismaService, 'docReview' | 'reviewRound'>,
    ): Promise<boolean> => {
      const res = await db.docReview.updateMany({
        where: { docId, version: expectedVersion, doc: { spaceId } },
        data: {
          status: data.status,
          currentRound: data.roundNumber,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) return false;

      if (db.reviewRound?.upsert) {
        await db.reviewRound.upsert({
          where: {
            docId_roundNumber: { docId, roundNumber: data.roundNumber },
          },
          create: {
            docId,
            roundNumber: data.roundNumber,
            status: data.status,
            requestedById: data.requestedById,
            requestedAt: data.requestedAt,
            verdictById: data.verdictById,
            verdictAt: data.verdictAt,
            notes: data.notes,
            deadline: data.deadline,
          },
          update: {
            status: data.status,
            requestedById: data.requestedById,
            requestedAt: data.requestedAt,
            verdictById: data.verdictById,
            verdictAt: data.verdictAt,
            notes: data.notes,
            deadline: data.deadline,
          },
        });
      }
      return true;
    };

    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(async (tx) => {
        const client = tx?.docReview ? tx : this.prisma;
        return applyUpdate(client);
      });
    }
    return applyUpdate(this.prisma);
  }

  public async createOrUpsertDocReview(
    docId: string,
    _spaceId: string,
    data: {
      status: ReviewStatus;
      roundNumber: number;
      requestedById: string | null;
      requestedAt: Date | null;
      verdictById: string | null;
      verdictAt: Date | null;
      notes: string | null;
      deadline: Date | null;
    },
  ): Promise<void> {
    if (!this.prisma.docReview) return;

    const applyCreate = async (
      db: Pick<PrismaService, 'docReview' | 'reviewRound'>,
    ) => {
      if (db.docReview.create) {
        await db.docReview.create({
          data: {
            docId,
            status: data.status,
            currentRound: data.roundNumber,
            version: 1,
          },
        });
      } else if (db.docReview.upsert) {
        await db.docReview.upsert({
          where: { docId },
          create: {
            docId,
            status: data.status,
            currentRound: data.roundNumber,
            version: 1,
          },
          update: {
            status: data.status,
            currentRound: data.roundNumber,
            version: { increment: 1 },
          },
        });
      }

      if (db.reviewRound?.upsert) {
        await db.reviewRound.upsert({
          where: {
            docId_roundNumber: { docId, roundNumber: data.roundNumber },
          },
          create: {
            docId,
            roundNumber: data.roundNumber,
            status: data.status,
            requestedById: data.requestedById,
            requestedAt: data.requestedAt,
            verdictById: data.verdictById,
            verdictAt: data.verdictAt,
            notes: data.notes,
            deadline: data.deadline,
          },
          update: {
            status: data.status,
            requestedById: data.requestedById,
            requestedAt: data.requestedAt,
            verdictById: data.verdictById,
            verdictAt: data.verdictAt,
            notes: data.notes,
            deadline: data.deadline,
          },
        });
      }
    };

    if (typeof this.prisma.$transaction === 'function') {
      await this.prisma.$transaction(async (tx) => {
        const client = tx?.docReview ? tx : this.prisma;
        await applyCreate(client);
      });
      return;
    }
    await applyCreate(this.prisma);
  }
}
