import { Injectable } from '@nestjs/common';
import {
  PageCommentReply,
  PageCommentThread,
  PageDocReview,
  PageReviewStatus,
  PageTrackChange,
  Prisma,
} from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '@/core';
import { ensureCanonicalPageId } from '@/modules/pages/core/page-scope.helper';
import {
  ChangeStatus,
  CommentReply,
  CommentThread,
  TextRange,
  TrackChange,
} from './domain';

export type ThreadWithReplies = PageCommentThread & {
  replies?: PageCommentReply[];
};

export class ReviewMapper {
  public static toDomainChange(row: PageTrackChange): TrackChange {
    return TrackChange.create({
      id: row.id,
      spaceId: row.spaceId,
      pageId: row.pageId,
      docId: row.docId,
      type: row.type,
      status: row.status,
      text: row.text,
      range: TextRange.create({
        startLine: row.startLine,
        startCol: row.startCol,
        endLine: row.endLine,
        endCol: row.endCol,
      }),
      createdById: row.createdById,
      resolvedById: row.resolvedById,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toDomainReply(row: PageCommentReply): CommentReply {
    return CommentReply.create({
      id: row.id,
      threadId: row.threadId,
      content: row.content,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toDomainThread(row: ThreadWithReplies): CommentThread {
    const replies = row.replies
      ? row.replies.map((r) => this.toDomainReply(r))
      : [];

    return CommentThread.create({
      id: row.id,
      spaceId: row.spaceId,
      pageId: row.pageId,
      docId: row.docId,
      quote: row.quote,
      range: TextRange.create({
        startLine: row.startLine,
        startCol: row.startCol,
        endLine: row.endLine,
        endCol: row.endCol,
      }),
      isResolved: row.isResolved,
      createdById: row.createdById,
      resolvedById: row.resolvedById,
      resolvedAt: row.resolvedAt,
      replies,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}

@Injectable()
export class ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  public getPrisma(): PrismaService {
    return this.prisma;
  }

  private async resolveDocPageId(
    spaceId: string,
    docId: string,
  ): Promise<string> {
    if (this.prisma.pageDoc?.findUnique) {
      const doc = await Promise.resolve(
        this.prisma.pageDoc.findUnique({
          where: { id: docId },
          select: { pageId: true },
        }),
      ).catch(() => null);
      if (doc?.pageId) return doc.pageId;
    }
    return ensureCanonicalPageId(this.prisma, spaceId, docId);
  }

  // ── Track Changes ──────────────────────────────────────────────────────────

  public async saveChange(change: TrackChange): Promise<TrackChange> {
    const { range } = change;
    const pageId = await this.resolveDocPageId(change.spaceId, change.docId);
    const record = await this.prisma.pageTrackChange.upsert({
      where: { id: change.id },
      create: {
        id: change.id,
        spaceId: change.spaceId,
        pageId,
        docId: change.docId,
        type: change.type,
        status: change.status,
        text: change.text,
        startLine: range.startLine,
        startCol: range.startCol,
        endLine: range.endLine,
        endCol: range.endCol,
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
    });
    return ReviewMapper.toDomainChange(record);
  }

  public async findChange(
    spaceId: string,
    changeId: string,
    docId?: string,
  ): Promise<PageTrackChange | null> {
    if (!isUUID(changeId)) return null;
    return this.prisma.pageTrackChange.findFirst({
      where: {
        id: changeId,
        spaceId,
        ...(docId && isUUID(docId) ? { docId } : {}),
      },
    });
  }

  public async listChanges(
    spaceId: string,
    docId: string,
    status?: ChangeStatus,
  ): Promise<TrackChange[]> {
    const where: Prisma.PageTrackChangeWhereInput = { spaceId, docId };
    if (status) where.status = status;

    const records = await this.prisma.pageTrackChange.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return records.map((r) => ReviewMapper.toDomainChange(r));
  }

  public async updateChange(
    spaceId: string,
    changeId: string,
    data: Prisma.PageTrackChangeUpdateInput,
  ): Promise<boolean> {
    const res = await this.prisma.pageTrackChange.updateMany({
      where: { id: changeId, spaceId },
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
      db: Pick<PrismaService, 'pageTrackChange'>,
    ): Promise<string[]> => {
      const claimed: string[] = [];
      for (const id of uniqueIds) {
        const res = await db.pageTrackChange.updateMany({
          where: {
            id,
            spaceId,
            status: 'pending',
            ...(docId && isUUID(docId) ? { docId } : {}),
          },
          data: {
            status: nextStatus,
            resolvedAt,
            resolvedById,
            updatedAt: resolvedAt,
          },
        });
        if (res.count === 1) claimed.push(id);
      }
      return claimed;
    };

    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(async (tx) => {
        const client = tx?.pageTrackChange ? tx : this.prisma;
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
    await this.prisma.pageTrackChange.updateMany({
      where: {
        id: { in: changeIds },
        spaceId,
        status: expectedStatus,
      },
      data: {
        status: 'pending',
        resolvedAt: null,
        resolvedById: null,
        updatedAt: new Date(),
      },
    });
  }

  // ── Comments & Replies ─────────────────────────────────────────────────────

  public async saveThread(thread: CommentThread): Promise<CommentThread> {
    const { range } = thread;
    const pageId = await this.resolveDocPageId(thread.spaceId, thread.docId);
    const record = await this.prisma.pageCommentThread.upsert({
      where: { id: thread.id },
      create: {
        id: thread.id,
        spaceId: thread.spaceId,
        pageId,
        docId: thread.docId,
        quote: thread.quote,
        startLine: range.startLine,
        startCol: range.startCol,
        endLine: range.endLine,
        endCol: range.endCol,
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
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    });
    return ReviewMapper.toDomainThread(record);
  }

  public async findThread(
    spaceId: string,
    threadId: string,
    docId?: string,
  ): Promise<(PageCommentThread & { replies: PageCommentReply[] }) | null> {
    if (!isUUID(threadId)) return null;
    return this.prisma.pageCommentThread.findFirst({
      where: {
        id: threadId,
        spaceId,
        ...(docId && isUUID(docId) ? { docId } : {}),
      },
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    });
  }

  public async listThreads(
    spaceId: string,
    docId: string,
    isResolved?: boolean,
  ): Promise<CommentThread[]> {
    const where: Prisma.PageCommentThreadWhereInput = { spaceId, docId };
    if (isResolved !== undefined) where.isResolved = isResolved;

    const records = await this.prisma.pageCommentThread.findMany({
      where,
      include: { replies: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return records.map((r) => ReviewMapper.toDomainThread(r));
  }

  public async updateThread(
    spaceId: string,
    threadId: string,
    data: Prisma.PageCommentThreadUpdateInput,
  ): Promise<boolean> {
    const res = await this.prisma.pageCommentThread.updateMany({
      where: { id: threadId, spaceId },
      data,
    });
    return res.count > 0;
  }

  public async deleteThread(
    spaceId: string,
    threadId: string,
  ): Promise<boolean> {
    const res = await this.prisma.pageCommentThread.deleteMany({
      where: { id: threadId, spaceId },
    });
    return res.count > 0;
  }

  public async addReply(
    threadId: string,
    reply: CommentReply,
  ): Promise<CommentReply> {
    const record = await this.prisma.pageCommentReply.create({
      data: {
        id: reply.id,
        threadId,
        content: reply.content,
        createdById: reply.createdById,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
      },
    });
    return ReviewMapper.toDomainReply(record);
  }

  public async updateReply(
    threadId: string,
    replyId: string,
    content: string,
  ): Promise<boolean> {
    if (!isUUID(threadId) || !isUUID(replyId)) return false;
    const res = await this.prisma.pageCommentReply.updateMany({
      where: { id: replyId, threadId },
      data: { content: content.trim(), updatedAt: new Date() },
    });
    return res.count > 0;
  }

  public async deleteReply(
    threadId: string,
    replyId: string,
  ): Promise<boolean> {
    if (!isUUID(threadId) || !isUUID(replyId)) return false;
    const res = await this.prisma.pageCommentReply.deleteMany({
      where: { id: replyId, threadId },
    });
    return res.count > 0;
  }

  // ── Overview & Document Review Status ──────────────────────────────────────

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

    const [docs, nodes, allThreads, allChanges] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: { spaceId: targetSpaceId, ...pageFilter, deletedAt: null },
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
      this.prisma.pageCommentThread.findMany({
        where: { spaceId: targetSpaceId, ...pageFilter },
        include: { replies: { orderBy: { createdAt: 'asc' } } },
        orderBy: [{ startLine: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.pageTrackChange.findMany({
        where: { spaceId: targetSpaceId, ...pageFilter },
        orderBy: [
          { startLine: 'asc' },
          { startCol: 'asc' },
          { createdAt: 'asc' },
        ],
      }),
    ]);

    return { docs, nodes, allThreads, allChanges };
  }

  public async findDocReview(docId: string): Promise<PageDocReview | null> {
    if (!this.prisma.pageDocReview?.findUnique) return null;
    return Promise.resolve(
      this.prisma.pageDocReview.findUnique({ where: { docId } }),
    ).catch(() => null);
  }

  public async updateDocReviewCas(
    docId: string,
    spaceId: string,
    expectedVersion: number,
    data: {
      status: PageReviewStatus;
      roundNumber: number;
      requestedById: string | null;
      requestedAt: Date | null;
      verdictById: string | null;
      verdictAt: Date | null;
      notes: string | null;
      deadline: Date | null;
    },
  ): Promise<boolean> {
    if (!this.prisma.pageDocReview?.updateMany) return true;
    const res = await this.prisma.pageDocReview.updateMany({
      where: { docId, spaceId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    return res.count > 0;
  }

  public async createOrUpsertDocReview(
    docId: string,
    spaceId: string,
    data: {
      status: PageReviewStatus;
      roundNumber: number;
      requestedById: string | null;
      requestedAt: Date | null;
      verdictById: string | null;
      verdictAt: Date | null;
      notes: string | null;
      deadline: Date | null;
    },
  ): Promise<void> {
    if (!this.prisma.pageDocReview) return;
    if (this.prisma.pageDocReview.create) {
      await this.prisma.pageDocReview.create({
        data: { docId, spaceId, version: 1, ...data },
      });
    } else if (this.prisma.pageDocReview.upsert) {
      await this.prisma.pageDocReview.upsert({
        where: { docId },
        create: { docId, spaceId, version: 1, ...data },
        update: { ...data, version: { increment: 1 } },
      });
    }
  }
}
