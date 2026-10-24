/**
 * track-changes/track-changes.repository.ts
 * Direct Injectable Prisma Persistence Repository & Domain Mapper for Track Changes & Comment Threads.
 */

import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ManuscriptTrackChange as PrismaTrackChange,
  ManuscriptCommentThread as PrismaCommentThread,
  ManuscriptCommentReply as PrismaCommentReply,
} from '@prisma/client';
import { PrismaService } from '@/core';
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
      projectId: prisma.projectId,
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
      projectId: prisma.projectId,
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

  public async saveChange(change: TrackChange): Promise<TrackChange> {
    const range = change.range;
    const record = await this.prisma.manuscriptTrackChange.upsert({
      where: { id: change.id },
      create: {
        id: change.id,
        projectId: change.projectId,
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
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.manuscriptTrackChange.updateMany({
      where: { id: { in: ids } },
      data: {
        status,
        resolvedById: resolvedById ?? null,
        resolvedAt: resolvedAt ?? new Date(),
        updatedAt: new Date(),
      },
    });
  }

  public async findChangeById(changeId: string): Promise<TrackChange | null> {
    const record = await this.prisma.manuscriptTrackChange.findUnique({
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
    const where: Prisma.ManuscriptTrackChangeWhereInput = { projectId, docId };
    if (status) {
      where.status = status;
    }

    const records = await this.prisma.manuscriptTrackChange.findMany({
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
    const record = await this.prisma.manuscriptCommentThread.upsert({
      where: { id: thread.id },
      create: {
        id: thread.id,
        projectId: thread.projectId,
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
    const record = await this.prisma.manuscriptCommentThread.findUnique({
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
    const where: Prisma.ManuscriptCommentThreadWhereInput = {
      projectId,
      docId,
    };
    if (isResolved !== undefined) {
      where.isResolved = isResolved;
    }

    const records = await this.prisma.manuscriptCommentThread.findMany({
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
    const record = await this.prisma.manuscriptCommentReply.create({
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
}
