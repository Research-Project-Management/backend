import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeAccessService } from './realtime-access.service';
import { PagesGateway } from './pages.gateway';
import { RoomStore } from './room.store';
import { PresenceMapper } from './presence.mapper';
import { YjsService } from './yjs.service';
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
    private readonly gateway: PagesGateway,
    @Optional() private readonly roomStore?: RoomStore,
    @Optional() private readonly yjs?: YjsService,
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
        const clientSpaceId = socket.data?.spaceId;

        if (clientUserId === userId && clientSpaceId === projectId) {
          // Notify client of revocation (RT-08 / SC-007)
          socket.emit('access:revoked', { spaceId: projectId });

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
          socket.data.spaceId = null;
          socket.data.activeDocId = null;

          if (activeDocId && this.yjs) {
            const docRoom = server.sockets?.adapter?.rooms?.get(
              `doc:${projectId}:${activeDocId}`,
            );
            if (!docRoom || docRoom.size === 0) {
              await this.yjs.evictDoc(projectId, activeDocId).catch(() => null);
            } else {
              await this.yjs.flushDoc(projectId, activeDocId).catch(() => null);
            }
          }

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
      const freshAccess =
        typeof this.realtimeAccess.getProjectAccess === 'function'
          ? await this.realtimeAccess
              .getProjectAccess(projectId, userId)
              .catch(() => null)
          : null;
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
          socket.data?.spaceId === projectId
        ) {
          socket.emit('access:updated', {
            spaceId: projectId,
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

  @OnEvent('project.ownership_transferred')
  public handleOwnershipTransferred(event: {
    projectId?: string;
    previousOwnerId?: string;
    newOwnerId?: string;
  }): void {
    if (!event?.projectId) return;
    if (event.previousOwnerId) {
      this.realtimeAccess.evictCache(event.projectId, event.previousOwnerId);
    }
    if (event.newOwnerId) {
      this.realtimeAccess.evictCache(event.projectId, event.newOwnerId);
    }
  }

  @OnEvent('project.deleted')
  public async handleProjectDeleted(event: {
    projectId?: string;
    entityId?: string;
  }): Promise<void> {
    const projectId = event?.projectId || event?.entityId;
    if (!projectId) return;
    try {
      const server = this.gateway?.server;
      if (server && typeof server.fetchSockets === 'function') {
        const sockets = await server.fetchSockets();
        for (const socket of sockets) {
          if (socket.data?.spaceId === projectId) {
            socket.emit('access:revoked', {
              spaceId: projectId,
              reason: 'project_deleted',
            });
            const docId = socket.data?.activeDocId;
            socket.leave(`project:${projectId}`);
            if (docId) {
              socket.leave(`doc:${projectId}:${docId}`);
            }
            socket.data.spaceId = null;
            socket.data.activeDocId = null;
          }
        }
      }
      if (this.yjs && typeof this.yjs.flushProjectDocs === 'function') {
        await this.yjs.flushProjectDocs(projectId).catch(() => []);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed project.deleted socket cleanup for ${projectId}: ${(err as Error)?.message}`,
      );
    }
  }
}
