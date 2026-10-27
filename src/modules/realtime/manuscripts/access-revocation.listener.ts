import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeAccessService } from './realtime-access.service';
import { ManuscriptsGateway } from './manuscripts.gateway';
import { RoomStore } from './room.store';
import { PresenceMapper } from './presence.mapper';
import { REALTIME_EVENTS } from '../core/realtime.constant';

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
    @Optional() private readonly roomStore?: RoomStore,
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

          const activeDocId = socket.data?.activeDocId;
          if (activeDocId) {
            this.gateway.broadcastToDoc?.(
              projectId,
              activeDocId,
              REALTIME_EVENTS.USER_LEFT_DOC,
              PresenceMapper.toLeavePresence(userId, socket.id),
              socket.id,
            );
          }

          this.gateway.broadcastToProject?.(
            projectId,
            REALTIME_EVENTS.USER_LEFT_PROJECT,
            PresenceMapper.toLeavePresence(userId, socket.id),
            socket.id,
          );

          if (this.roomStore) {
            await this.roomStore
              .removeProjectSession(projectId, socket.id)
              .catch(() => null);
          }

          // Leave rooms
          socket.leave(`project:${projectId}`);
          if (activeDocId) {
            socket.leave(`doc:${projectId}:${activeDocId}`);
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
    const newRole =
      event.newRole || event.role || event.metadata?.newRole || event.newValue;

    if (!projectId || !userId) {
      return;
    }

    this.logger.log(
      `Handling project.member_updated for user ${userId} in project ${projectId} (newRole: ${newRole ?? 'unspecified'})`,
    );

    // Evict cached access decision so the next write/read operation re-evaluates permissions immediately (RT-10)
    this.realtimeAccess.evictCache(projectId, userId);

    // Notify live sockets of the updated role so the frontend immediately switches to read-only if downgraded to reviewer
    try {
      const server = this.gateway?.server;
      if (!server || typeof server.fetchSockets !== 'function') {
        return;
      }
      const freshAccess = await this.realtimeAccess
        .getProjectAccess(projectId, userId)
        .catch(() => null);
      const resolvedCanWrite =
        freshAccess !== null
          ? freshAccess.canWrite
          : newRole
            ? newRole.toLowerCase() !== 'reviewer' &&
              newRole.toLowerCase() !== 'viewer'
            : undefined;
      const resolvedRole = newRole ?? freshAccess?.role;

      const sockets = await server.fetchSockets();
      for (const socket of sockets) {
        if (
          socket.data?.userId === userId &&
          socket.data?.projectId === projectId
        ) {
          socket.emit('access:updated', {
            projectId,
            userId,
            role: resolvedRole,
            canWrite: resolvedCanWrite,
          });
        }
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to notify sockets for updated member ${userId} in project ${projectId}: ${(err as Error)?.message}`,
      );
    }
  }
}
