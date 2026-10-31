/**
 * track-changes/adapters/track-changes.adapters.ts
 * Driven Cross-Context Adapters for Track Changes & Review Comment Threads:
 * - DocstorePatcherAdapter (Port: IDocstorePatcherPort)
 * - RealtimeNotifierAdapter (Port: IRealtimeNotifierPort)
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/core';
import {
  LiveCollaborationPort,
  LIVE_COLLABORATION_PORT,
  NOOP_LIVE_COLLABORATION,
  ManuscriptDomainEventBus,
} from '@/modules/manuscripts/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import {
  IDocstorePatcherPort,
  IRealtimeNotifierPort,
  PatcherResult,
  TrackChange,
  CommentThread,
  CommentReply,
  LinePatcher,
  LinePatchComputation,
} from '../domain';

@Injectable()
export class DocstorePatcherAdapter extends IDocstorePatcherPort {
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
  ) {
    super();
    const candidate = liveCollab ?? liveCollabOrLegacyRef;
    this.liveCollab =
      candidate &&
      typeof (candidate as LiveCollaborationPort).flushDocs === 'function'
        ? (candidate as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
  }

  private getLiveCollab(): LiveCollaborationPort {
    return this.liveCollab;
  }

  /**
   * Template Method: Centralizes live-doc flushing, line-patch evaluation,
   * conditional DB persistence (preventing no-op version increments), and domain event propagation.
   */
  private async executeDocPatch(
    projectId: string,
    docId: string,
    computePatch: (currentLines: readonly string[]) => LinePatchComputation,
  ): Promise<PatcherResult> {
    const live = this.getLiveCollab();
    await live.flushDocs(projectId, [docId]).catch(() => []);

    const maxAttempts = 3;
    let updated: Awaited<ReturnType<DocstoreService['updateDoc']>> | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      const { lines, mutated } = computePatch(doc.lines);

      if (!mutated) {
        return {
          lines,
          newRev: doc.rev,
        };
      }

      try {
        updated = await this.docstoreService.updateDoc(projectId, docId, {
          lines,
          version: (doc.version ?? 0) + 1,
          expectedRev: doc.rev,
        });
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        const name = (err as { name?: string })?.name;
        const isConflict =
          status === 409 ||
          name === 'ConflictException' ||
          name === 'DocRevisionConflictException';
        if (isConflict && attempt < maxAttempts - 1) {
          continue;
        }
        throw err;
      }
    }

    if (!updated) {
      throw new Error(`Failed to patch document ${docId} after retries.`);
    }

    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.document.mutated',
        projectId,
        docId,
        lines: updated.doc.lines || [''],
        rev: updated.doc.rev,
        version: updated.doc.version,
        source: 'track-changes',
        occurredAt: Date.now(),
      });
    } else {
      await live
        .applyExternalText(
          projectId,
          docId,
          (updated.doc.lines || ['']).join('\n'),
        )
        .catch(() => false);
    }

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }

  public async applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    return this.executeDocPatch(projectId, docId, (lines) =>
      LinePatcher.computeAcceptedPatch(lines, change),
    );
  }

  public async revertChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    return this.executeDocPatch(projectId, docId, (lines) =>
      LinePatcher.computeRejectedPatch(lines, change),
    );
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

    return this.executeDocPatch(projectId, docId, (initialLines) => {
      let currentLines = [...initialLines];
      let anyMutated = false;

      for (const change of changes) {
        const res = isAccept
          ? LinePatcher.computeAcceptedPatch(currentLines, change)
          : LinePatcher.computeRejectedPatch(currentLines, change);
        currentLines = res.lines;
        if (res.mutated) anyMutated = true;
      }

      return { lines: currentLines, mutated: anyMutated };
    });
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

          const mentionCollaborators: Record<string, string> = {};
          for (const [k, userId] of Object.entries(ctx.collaboratorMap)) {
            if (
              threadOwnerId &&
              threadOwnerId !== reply.createdById &&
              userId === threadOwnerId
            ) {
              continue;
            }
            mentionCollaborators[k] = userId;
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
            collaboratorMap: mentionCollaborators,
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

    if (!thread.isResolved) {
      return;
    }

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
