/**
 * track-changes/core/adapters/external/realtime-notifier.adapter.ts
 * Driven Adapter implementing IRealtimeNotifierPort using RealtimeService to broadcast updates.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { IRealtimeNotifierPort } from '../../ports/realtime-notifier.port';
import { TrackChange } from '../../domain/entities/track-change.entity';
import { CommentThread } from '../../domain/entities/comment-thread.entity';
import { CommentReply } from '../../domain/entities/comment-reply.entity';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class RealtimeNotifierAdapter extends IRealtimeNotifierPort {
  private readonly logger = new Logger(RealtimeNotifierAdapter.name);

  constructor(
    @Optional() private readonly realtimeService?: RealtimeService,
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
      const project = await (this.prisma as any).project.findUnique({
        where: { id: projectId },
        include: {
          owner: { select: { id: true, name: true, email: true } },
          members: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });

      if (project) {
        projectName = project.name || projectName;
        if (project.owner) {
          collaboratorMap[project.owner.email.toLowerCase()] = project.owner.id;
          if (project.owner.name) {
            collaboratorMap[project.owner.name.toLowerCase().replace(/\s+/g, '')] = project.owner.id;
          }
          if (actorId && project.owner.id === actorId && project.owner.name) {
            actorName = project.owner.name;
          }
        }
        for (const member of project.members || []) {
          if (member.user) {
            collaboratorMap[member.user.email.toLowerCase()] = member.user.id;
            if (member.user.name) {
              collaboratorMap[member.user.name.toLowerCase().replace(/\s+/g, '')] = member.user.id;
            }
            if (actorId && member.user.id === actorId && member.user.name) {
              actorName = member.user.name;
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.debug(`Could not resolve project collaborator map for ${projectId}: ${err?.message}`);
    }

    return { collaboratorMap, projectName, actorName };
  }

  public notifyChangeRecorded(projectId: string, docId: string, change: TrackChange): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'track-changes:recorded', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyChangeResolved(projectId: string, docId: string, change: TrackChange): void {
    if (!this.realtimeService) return;
    this.realtimeService.broadcastEvent(projectId, 'track-changes:resolved', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyCommentCreated(projectId: string, docId: string, thread: CommentThread): void {
    if (this.realtimeService) {
      this.realtimeService.broadcastEvent(projectId, 'comment:created', {
        docId,
        thread: thread.toJSON(),
      });
    }

    if (this.notificationsService && thread.replies && thread.replies.length > 0) {
      const firstReply = thread.replies[0];
      this.getCollaboratorContext(projectId, thread.createdById)
        .then(async (ctx) => {
          await this.notificationsService?.parseAndNotifyMentions({
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
          this.logger.debug(`Failed to dispatch mention notifications: ${err?.message}`);
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
    if (this.realtimeService) {
      this.realtimeService.broadcastEvent(projectId, 'comment:replied', {
        docId,
        threadId,
        reply: reply.toJSON(),
      });
    }

    if (this.notificationsService) {
      this.getCollaboratorContext(projectId, reply.createdById)
        .then(async (ctx) => {
          // 1. Overleaf Parity: Notify thread creator about new reply (if reply is by another collaborator)
          if (threadOwnerId && threadOwnerId !== reply.createdById) {
            await this.notificationsService?.createNotification({
              userId: threadOwnerId,
              key: `comment-reply-${reply.id}-${threadOwnerId}`,
              templateKey: 'comment_reply',
              type: 'comment_reply',
              projectId,
              docId,
              actorId: reply.createdById || undefined,
              messageOpts: {
                actorId: reply.createdById,
                actorName: ctx.actorName,
                projectId,
                projectName: ctx.projectName,
                threadId,
                commentId: reply.id,
                snippet: reply.content.slice(0, 140),
              },
            });
          }

          // 2. Overleaf Parity: Parse mentions in reply body
          await this.notificationsService?.parseAndNotifyMentions({
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
          this.logger.debug(`Failed to dispatch reply notifications: ${err?.message}`);
        });
    }
  }

  public notifyCommentResolved(projectId: string, docId: string, thread: CommentThread): void {
    if (this.realtimeService) {
      this.realtimeService.broadcastEvent(projectId, 'comment:resolved', {
        docId,
        thread: thread.toJSON(),
      });
    }

    if (this.notificationsService) {
      this.getCollaboratorContext(projectId, thread.resolvedById)
        .then(async (ctx) => {
          // 1. Overleaf Parity: Dismiss mention / reply notifications when thread is resolved
          await this.notificationsService?.deleteByKey(`comment-mention-${thread.id}`);

          // 2. Notify thread owner if resolved by someone else
          if (thread.createdById && thread.createdById !== thread.resolvedById) {
            await this.notificationsService?.createNotification({
              userId: thread.createdById,
              key: `thread-resolved-${thread.id}-${thread.createdById}`,
              templateKey: 'thread_resolved',
              type: 'thread_resolved',
              projectId,
              docId,
              actorId: thread.resolvedById || undefined,
              messageOpts: {
                actorId: thread.resolvedById,
                actorName: ctx.actorName,
                projectId,
                projectName: ctx.projectName,
                threadId: thread.id,
                quote: thread.quote,
              },
            });
          }
        })
        .catch((err) => {
          this.logger.debug(`Failed to dispatch thread-resolved notification: ${err?.message}`);
        });
    }
  }
}
