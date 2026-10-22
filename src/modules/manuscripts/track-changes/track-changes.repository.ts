/**
 * track-changes/track-changes.repository.ts
 * Direct Injectable Repository & Driven Adapters for Track Changes & Review Comment Threads.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  ManuscriptTrackChange as PrismaTrackChange,
  ManuscriptCommentThread as PrismaCommentThread,
  ManuscriptCommentReply as PrismaCommentReply,
} from '@prisma/client';
import { PrismaService } from '@/core';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import {
  ITrackChangesRepositoryPort,
  IDocstorePatcherPort,
  IRealtimeNotifierPort,
  PatcherResult,
  TrackChange,
  ChangeStatus,
  CommentThread,
  CommentReply,
  TextRangeVo,
  LinePatcher,
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
export class DocstorePatcherAdapter extends IDocstorePatcherPort {
  constructor(
    private readonly docstoreService: DocstoreService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    super();
  }

  public async applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    const doc = await this.docstoreService.getDoc(projectId, docId);
    const { lines, mutated } = LinePatcher.computeAcceptedPatch(
      doc.lines,
      change,
    );

    if (!mutated) {
      return {
        lines,
        newRev: doc.rev,
      };
    }

    const updated = await this.docstoreService.updateDoc(projectId, docId, {
      lines,
      version: doc.version,
    });

    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, {
        strict: false,
      });
      if (live) {
        await live.applyExternalText(
          projectId,
          docId,
          (updated.doc.lines || ['']).join('\n'),
        );
      }
    } catch {
      // non-blocking fallback
    }

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }

  public async revertChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    const doc = await this.docstoreService.getDoc(projectId, docId);
    const { lines } = LinePatcher.computeRejectedPatch(doc.lines, change);

    const updated = await this.docstoreService.updateDoc(projectId, docId, {
      lines,
      version: doc.version,
    });

    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, {
        strict: false,
      });
      if (live) {
        await live.applyExternalText(
          projectId,
          docId,
          (updated.doc.lines || ['']).join('\n'),
        );
      }
    } catch {
      // non-blocking fallback
    }

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }

  public async applyBatchChanges(
    projectId: string,
    docId: string,
    changes: TrackChange[],
    isAccept: boolean,
  ): Promise<PatcherResult | null> {
    if (changes.length === 0) {
      return null;
    }

    const doc = await this.docstoreService.getDoc(projectId, docId);
    let currentLines = doc.lines;
    let anyMutated = false;

    for (const change of changes) {
      if (isAccept) {
        const res = LinePatcher.computeAcceptedPatch(currentLines, change);
        currentLines = res.lines;
        if (res.mutated) anyMutated = true;
      } else {
        const res = LinePatcher.computeRejectedPatch(currentLines, change);
        currentLines = res.lines;
        if (res.mutated) anyMutated = true;
      }
    }

    if (!anyMutated) {
      return {
        lines: currentLines,
        newRev: doc.rev,
      };
    }

    const updated = await this.docstoreService.updateDoc(projectId, docId, {
      lines: currentLines,
      version: doc.version,
    });

    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, {
        strict: false,
      });
      if (live) {
        await live.applyExternalText(
          projectId,
          docId,
          (updated.doc.lines || ['']).join('\n'),
        );
      }
    } catch {
      // non-blocking fallback
    }

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }
}

@Injectable()
export class RealtimeNotifierAdapter extends IRealtimeNotifierPort {
  private readonly logger = new Logger(RealtimeNotifierAdapter.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    super();
  }

  private async getCollaboratorContext(
    projectId: string,
    actorId?: string | null,
  ): Promise<{
    collaboratorMap: Record<string, string>;
    projectName: string;
    actorName: string;
  }> {
    const collaboratorMap: Record<string, string> = {};
    let projectName = 'Manuscript';
    let actorName = 'Collaborator';

    if (!this.prisma) return { collaboratorMap, projectName, actorName };

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        include: {
          createdBy: {
            select: {
              id: true,
              email: true,
              profile: { select: { name: true } },
            },
          },
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  profile: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      if (project) {
        projectName = project.name || projectName;
        const owner = project.createdBy;
        if (owner) {
          collaboratorMap[owner.email.toLowerCase()] = owner.id;
          const ownerName = owner.profile?.name;
          if (ownerName) {
            collaboratorMap[ownerName.toLowerCase().replace(/\s+/g, '')] =
              owner.id;
          }
          if (actorId && owner.id === actorId && ownerName) {
            actorName = ownerName;
          }
        }
        for (const member of project.members || []) {
          if (member.user) {
            collaboratorMap[member.user.email.toLowerCase()] = member.user.id;
            const memberName = member.user.profile?.name;
            if (memberName) {
              collaboratorMap[memberName.toLowerCase().replace(/\s+/g, '')] =
                member.user.id;
            }
            if (actorId && member.user.id === actorId && memberName) {
              actorName = memberName;
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Could not resolve project collaborator map for ${projectId}: ${msg}`,
      );
    }

    return { collaboratorMap, projectName, actorName };
  }

  private emitEvent(projectId: string, eventName: string, data: unknown): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit('manuscripts.track-changes.event', {
      projectId,
      eventName,
      data,
    });
  }

  public notifyChangeRecorded(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): void {
    this.emitEvent(projectId, 'track-changes:recorded', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyChangeResolved(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): void {
    this.emitEvent(projectId, 'track-changes:resolved', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyCommentCreated(
    projectId: string,
    docId: string,
    thread: CommentThread,
  ): void {
    this.emitEvent(projectId, 'comment:created', {
      docId,
      thread: thread.toJSON(),
    });

    if (
      this.notificationsService?.manuscripts &&
      thread.replies &&
      thread.replies.length > 0
    ) {
      const firstReply = thread.replies[0];
      const manuscriptsNotifications = this.notificationsService.manuscripts;
      this.getCollaboratorContext(projectId, thread.createdById)
        .then(async (ctx) => {
          await manuscriptsNotifications.parseAndNotifyMentions({
            text: firstReply.content,
            actorId: thread.createdById || 'anonymous',
            actorName: ctx.actorName,
            projectId,
            projectName: ctx.projectName,
            docId,
            threadId: thread.id,
            commentId: firstReply.id,
            collaboratorMap: ctx.collaboratorMap,
          });
        })
        .catch((err) => {
          this.logger.debug(
            `Failed to dispatch mention notifications: ${err?.message}`,
          );
        });
    }
  }

  public notifyCommentReplied(
    projectId: string,
    docId: string,
    threadId: string,
    reply: CommentReply,
    threadOwnerId?: string | null,
  ): void {
    this.emitEvent(projectId, 'comment:replied', {
      docId,
      threadId,
      reply: reply.toJSON(),
    });

    if (this.notificationsService?.manuscripts) {
      const manuscriptsNotifications = this.notificationsService.manuscripts;
      this.getCollaboratorContext(projectId, reply.createdById)
        .then(async (ctx) => {
          if (threadOwnerId && threadOwnerId !== reply.createdById) {
            await manuscriptsNotifications.notifyCommentReply({
              recipientUserId: threadOwnerId,
              actorId: reply.createdById || 'anonymous',
              actorName: ctx.actorName,
              projectId,
              projectName: ctx.projectName,
              docId,
              threadId,
              replyId: reply.id,
              snippet: reply.content.slice(0, 140),
            });
          }

          await manuscriptsNotifications.parseAndNotifyMentions({
            text: reply.content,
            actorId: reply.createdById || 'anonymous',
            actorName: ctx.actorName,
            projectId,
            projectName: ctx.projectName,
            docId,
            threadId,
            commentId: reply.id,
            collaboratorMap: ctx.collaboratorMap,
          });
        })
        .catch((err) => {
          this.logger.debug(
            `Failed to dispatch reply notifications: ${err?.message}`,
          );
        });
    }
  }

  public notifyCommentResolved(
    projectId: string,
    docId: string,
    thread: CommentThread,
  ): void {
    this.emitEvent(projectId, 'comment:resolved', {
      docId,
      thread: thread.toJSON(),
    });

    if (this.notificationsService?.manuscripts) {
      const manuscriptsNotifications = this.notificationsService.manuscripts;
      this.getCollaboratorContext(projectId, thread.resolvedById)
        .then(async (ctx) => {
          await manuscriptsNotifications.dismissThreadNotifications(thread.id);

          if (
            thread.createdById &&
            thread.createdById !== thread.resolvedById
          ) {
            await manuscriptsNotifications.notifyThreadResolved({
              recipientUserId: thread.createdById,
              actorId: thread.resolvedById || 'anonymous',
              actorName: ctx.actorName,
              projectId,
              projectName: ctx.projectName,
              docId,
              threadId: thread.id,
              quote: thread.quote ?? undefined,
            });
          }
        })
        .catch((err) => {
          this.logger.debug(
            `Failed to dispatch thread-resolved notification: ${err?.message}`,
          );
        });
    }
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
