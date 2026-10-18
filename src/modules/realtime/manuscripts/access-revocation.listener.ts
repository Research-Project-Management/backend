import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeAccessService } from './realtime-access.service';
import { ManuscriptsGateway } from './manuscripts.gateway';

export interface MemberRemovedPayload {
  projectId?: string;
  userId?: string;
  entityId?: string;
  oldValue?: string;
  targetUserId?: string;
}

export interface MemberUpdatedPayload {
  projectId?: string;
  userId?: string;
  role?: string;
  newRole?: string;
  entityId?: string;
  newValue?: string;
  targetUserId?: string;
  metadata?: { targetId?: string; oldRole?: string; newRole?: string };
}

@Injectable()
export class AccessRevocationListener {
  private readonly logger = new Logger(AccessRevocationListener.name);

  constructor(
    private readonly realtimeAccess: RealtimeAccessService,
    @Inject(forwardRef(() => ManuscriptsGateway))
    private readonly gateway: ManuscriptsGateway,
  ) {}

  @OnEvent('project.member_removed')
  public async handleMemberRemoved(event: MemberRemovedPayload): Promise<void> {
    const projectId = event.projectId || event.entityId;
    const userId = event.userId || event.targetUserId || event.oldValue;

    if (!projectId || !userId) {
      return;
    }

    this.logger.log(
      `Handling project.member_removed for user ${userId} in project ${projectId}`,
    );

    // 1. Evict cached access decision
    this.realtimeAccess.evictCache(projectId, userId);

    // 2. Disconnect/evict matching live sockets from project and document rooms
    try {
      const server = this.gateway?.server;
      if (!server || typeof server.fetchSockets !== 'function') {
        return;
      }

      const sockets = await server.fetchSockets();
      for (const socket of sockets) {
        const clientUserId = socket.data?.userId;
        const clientProjectId = socket.data?.projectId;

        if (clientUserId === userId && clientProjectId === projectId) {
          // Notify client of revocation (RT-08 / SC-007)
          socket.emit('access:revoked', { projectId });

          // Leave rooms
          socket.leave(`project:${projectId}`);
          if (socket.data?.activeDocId) {
            socket.leave(`doc:${projectId}:${socket.data.activeDocId}`);
          }

          // Clear joined context
          socket.data.projectId = null;
          socket.data.activeDocId = null;

          this.logger.log(
            `Evicted socket ${socket.id} (user ${userId}) from project ${projectId} due to membership removal`,
          );
        }
      }
    } catch (err: unknown) {
      this.logger.error(
        `Failed to evict sockets for removed member ${userId} in project ${projectId}: ${(err as Error)?.message}`,
      );
    }
  }

  @OnEvent('project.member_updated')
  public async handleMemberUpdated(event: MemberUpdatedPayload): Promise<void> {
    const projectId = event.projectId || event.entityId;
    const userId =
      event.userId || event.targetUserId || event.metadata?.targetId;

    if (!projectId || !userId) {
      return;
    }

    this.logger.log(
      `Handling project.member_updated for user ${userId} in project ${projectId}`,
    );

    // Evict cached access decision so the next write/read operation re-evaluates permissions immediately (RT-10)
    this.realtimeAccess.evictCache(projectId, userId);
  }
}
