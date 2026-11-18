/**
 * track-changes/track-changes.repository.ts
 * Direct Injectable Prisma Persistence Repository & Domain Mapper for Track Changes & Comment Threads.
 */

import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PageTrackChange as PrismaTrackChange,
  PageCommentThread as PrismaCommentThread,
  PageCommentReply as PrismaCommentReply,
} from '@prisma/client';
import { PrismaService } from '@/core';
import { ensureCanonicalPageId } from '@/modules/pages/core/page-scope.helper';
import {
  ITrackChangesRepositoryPort,
  TrackChange,
  ChangeStatus,
  CommentThread,
  CommentReply,
  TextRangeVo,
} from './domain';

export type PrismaThreadWithReplies = PrismaCommentThread & {
  replies?: PrismaCommentReply[];
};

export class TrackChangesMapper {
  public static toDomainChange(prisma: PrismaTrackChange): TrackChange {
    return TrackChange.create({
      id: prisma.id,
      projectId: prisma.spaceId,
      spaceId: prisma.spaceId,
      pageId: prisma.pageId,
      docId: prisma.docId,
      type: prisma.type,
      status: prisma.status,
      text: prisma.text,
      range: TextRangeVo.create({
        startLine: prisma.startLine,
        startCol: prisma.startCol,
        endLine: prisma.endLine,
        endCol: prisma.endCol,
      }),
      createdById: prisma.createdById,
      resolvedById: prisma.resolvedById,
      resolvedAt: prisma.resolvedAt,
      createdAt: prisma.createdAt,
      updatedAt: prisma.updatedAt,
    });
  }

  public static toDomainReply(prisma: PrismaCommentReply): CommentReply {
    return CommentReply.create({
      id: prisma.id,
      threadId: prisma.threadId,
      content: prisma.content,
      createdById: prisma.createdById,
      createdAt: prisma.createdAt,
      updatedAt: prisma.updatedAt,
    });
  }

  public static toDomainThread(prisma: PrismaThreadWithReplies): CommentThread {
    const replies = prisma.replies
      ? prisma.replies.map((reply) => this.toDomainReply(reply))
      : [];

    return CommentThread.create({
      id: prisma.id,
      projectId: prisma.spaceId,
      spaceId: prisma.spaceId,
      pageId: prisma.pageId,
      docId: prisma.docId,
      quote: prisma.quote,
      range: TextRangeVo.create({
        startLine: prisma.startLine,
        startCol: prisma.startCol,
        endLine: prisma.endLine,
        endCol: prisma.endCol,
      }),
      isResolved: prisma.isResolved,
      createdById: prisma.createdById,
      resolvedById: prisma.resolvedById,
      resolvedAt: prisma.resolvedAt,
      replies,
      createdAt: prisma.createdAt,
      updatedAt: prisma.updatedAt,
    });
  }
}

@Injectable()
export class TrackChangesRepository extends ITrackChangesRepositoryPort {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private async resolveDocPageId(
    projectId: string,
    docId: string,
  ): Promise<string> {
    if (this.prisma.pageDoc?.findUnique) {
      const doc = await Promise.resolve(
        this.prisma.pageDoc.findUnique({
          where: { id: docId },
          select: { pageId: true },
        }),
      ).catch(() => null);
      if (doc?.pageId) {
        return doc.pageId;
      }
    }
    return ensureCanonicalPageId(this.prisma, projectId, docId);
  }

  public async saveChange(change: TrackChange): Promise<TrackChange> {
    const range = change.range;
    const pageId = await this.resolveDocPageId(change.projectId, change.docId);
    const record = await this.prisma.pageTrackChange.upsert({
      where: { id: change.id },
      create: {
        id: change.id,
        spaceId: change.projectId,
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

    return TrackChangesMapper.toDomainChange(record);
  }

  public async batchUpdateChangesStatus(
    ids: string[],
    status: ChangeStatus,
    resolvedById?: string | null,
    resolvedAt?: Date | null,
    projectId?: string,
    docId?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.pageTrackChange.updateMany({
      where: {
        id: { in: ids },
        ...(projectId ? { spaceId: projectId } : {}),
        ...(docId ? { docId } : {}),
      },
      data: {
        status,
        resolvedById: resolvedById ?? null,
        resolvedAt: resolvedAt ?? new Date(),
        updatedAt: new Date(),
      },
    });
  }

  public async claimPendingChanges(
    projectId: string,
    docId: string,
    changeIds: string[],
    nextStatus: 'accepted' | 'rejected',
    resolvedById?: string | null,
    resolvedAt: Date = new Date(),
  ): Promise<string[]> {
    const uniqueIds = Array.from(new Set(changeIds)).filter(Boolean);
    if (uniqueIds.length === 0) return [];

    const runClaim = async (
      db: Pick<PrismaService, 'pageTrackChange'>,
    ): Promise<string[]> => {
      const claimed: string[] = [];
      for (const id of uniqueIds) {
        const res = await db.pageTrackChange.updateMany({
          where: {
            id,
            spaceId: projectId,
            docId,
            status: 'pending',
          },
          data: {
            status: nextStatus,
            resolvedById: resolvedById ?? null,
            resolvedAt,
            updatedAt: resolvedAt,
          },
        });
        if (res.count === 1) {
          claimed.push(id);
        }
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

  public async revertClaimedChangesStatus(
    projectId: string,
    docId: string,
    changeIds: string[],
    expectedCurrentStatus: 'accepted' | 'rejected',
  ): Promise<void> {
    if (changeIds.length === 0) return;
    await this.prisma.pageTrackChange.updateMany({
      where: {
        id: { in: changeIds },
        spaceId: projectId,
        docId,
        status: expectedCurrentStatus,
      },
      data: {
        status: 'pending',
        resolvedById: null,
        resolvedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  public async findChangeById(changeId: string): Promise<TrackChange | null> {
    const record = await this.prisma.pageTrackChange.findUnique({
      where: { id: changeId },
    });
    if (!record) return null;
    return TrackChangesMapper.toDomainChange(record);
  }

  public async listChangesByDoc(
    projectId: string,
    docId: string,
    status?: ChangeStatus,
  ): Promise<TrackChange[]> {
    const where: Prisma.PageTrackChangeWhereInput = {
      spaceId: projectId,
      docId,
    };
    if (status) {
      where.status = status;
    }

    const records = await this.prisma.pageTrackChange.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    return records.map((r) => TrackChangesMapper.toDomainChange(r));
  }

  public async saveCommentThread(
    thread: CommentThread,
  ): Promise<CommentThread> {
    const range = thread.range;
    const pageId = await this.resolveDocPageId(thread.projectId, thread.docId);
    const record = await this.prisma.pageCommentThread.upsert({
      where: { id: thread.id },
      create: {
        id: thread.id,
        spaceId: thread.projectId,
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
      include: {
        replies: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return TrackChangesMapper.toDomainThread(record);
  }

  public async findThreadById(threadId: string): Promise<CommentThread | null> {
    const record = await this.prisma.pageCommentThread.findUnique({
      where: { id: threadId },
      include: {
        replies: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!record) return null;
    return TrackChangesMapper.toDomainThread(record);
  }

  public async listThreadsByDoc(
    projectId: string,
    docId: string,
    isResolved?: boolean,
  ): Promise<CommentThread[]> {
    const where: Prisma.PageCommentThreadWhereInput = {
      spaceId: projectId,
      docId,
    };
    if (isResolved !== undefined) {
      where.isResolved = isResolved;
    }

    const records = await this.prisma.pageCommentThread.findMany({
      where,
      include: {
        replies: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    return records.map((r) =>
      TrackChangesMapper.toDomainThread(r as PrismaThreadWithReplies),
    );
  }

  public async addCommentReply(
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

    return TrackChangesMapper.toDomainReply(record);
  }

  public async updateCommentReply(
    threadId: string,
    replyId: string,
    content: string,
  ): Promise<CommentReply | null> {
    const existing = await this.prisma.pageCommentReply.findFirst({
      where: { id: replyId, threadId },
    });
    if (!existing) return null;
    const updated = await this.prisma.pageCommentReply.update({
      where: { id: replyId },
      data: {
        content: content.trim(),
        updatedAt: new Date(),
      },
    });
    return TrackChangesMapper.toDomainReply(updated);
  }
}
