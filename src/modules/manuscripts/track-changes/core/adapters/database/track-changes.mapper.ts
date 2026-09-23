/**
 * track-changes/core/adapters/database/track-changes.mapper.ts
 * Mapper transforming between Prisma review models and Domain entities.
 */

import {
  ManuscriptTrackChange as PrismaTrackChange,
  ManuscriptCommentThread as PrismaCommentThread,
  ManuscriptCommentReply as PrismaCommentReply,
} from '@prisma/client';
import { TrackChange, ChangeType, ChangeStatus } from '../../domain/entities/track-change.entity';
import { CommentThread } from '../../domain/entities/comment-thread.entity';
import { CommentReply } from '../../domain/entities/comment-reply.entity';
import { TextRangeVo } from '../../domain/value-objects/text-range.vo';

export type PrismaThreadWithReplies = PrismaCommentThread & {
  replies?: PrismaCommentReply[];
};

export class TrackChangesMapper {
  public static toDomainChange(prisma: PrismaTrackChange): TrackChange {
    return TrackChange.create({
      id: prisma.id,
      projectId: prisma.projectId,
      docId: prisma.docId,
      type: prisma.type as ChangeType,
      status: prisma.status as ChangeStatus,
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
    const replies = prisma.replies ? prisma.replies.map(this.toDomainReply) : [];

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
