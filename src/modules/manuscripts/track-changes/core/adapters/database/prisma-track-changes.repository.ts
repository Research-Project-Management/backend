/**
 * track-changes/core/adapters/database/prisma-track-changes.repository.ts
 * Driven Adapter implementing ITrackChangesRepositoryPort using PostgreSQL via Prisma.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ITrackChangesRepositoryPort } from '../../ports/track-changes-repository.port';
import { TrackChange, ChangeStatus } from '../../domain/entities/track-change.entity';
import { CommentThread } from '../../domain/entities/comment-thread.entity';
import { CommentReply } from '../../domain/entities/comment-reply.entity';
import { TrackChangesMapper, PrismaThreadWithReplies } from './track-changes.mapper';

@Injectable()
export class PrismaTrackChangesRepository extends ITrackChangesRepositoryPort {
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
    const where: any = { projectId, docId };
    if (status) {
      where.status = status;
    }

    const records = await this.prisma.manuscriptTrackChange.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    return records.map(TrackChangesMapper.toDomainChange);
  }

  public async saveCommentThread(thread: CommentThread): Promise<CommentThread> {
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

    return TrackChangesMapper.toDomainThread(record as PrismaThreadWithReplies);
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
    return TrackChangesMapper.toDomainThread(record as PrismaThreadWithReplies);
  }

  public async listThreadsByDoc(
    projectId: string,
    docId: string,
    isResolved?: boolean,
  ): Promise<CommentThread[]> {
    const where: any = { projectId, docId };
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
    });

    return records.map((r) => TrackChangesMapper.toDomainThread(r as PrismaThreadWithReplies));
  }

  public async addCommentReply(threadId: string, reply: CommentReply): Promise<CommentReply> {
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

  public async deleteCommentThread(projectId: string, threadId: string): Promise<void> {
    await this.prisma.manuscriptCommentThread.deleteMany({
      where: {
        id: threadId,
        projectId,
      },
    });
  }
}
