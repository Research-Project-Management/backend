import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { RemoteSocket, Server } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io';
import { PAGES_EVENTS, PAGES_ROOMS } from '../pages.constants';
import { RoomPresenceStore } from '../presence/room-presence.store';
import { PresenceMapper } from '../presence/presence.mapper';
import type { ClientSocketData } from '../presence/presence.types';
import { YjsService } from '../yjs/yjs.service';
import { PagesGateway } from '../pages.gateway';
import { RealtimeAccessService } from './realtime-access.service';

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

type ManagedSocket = RemoteSocket<DefaultEventsMap, ClientSocketData>;

@Injectable()
export class AccessRevocationListener {
  private readonly logger = new Logger(AccessRevocationListener.name);

  constructor(
    private readonly realtimeAccess: RealtimeAccessService,
    private readonly gateway: PagesGateway,
    @Optional() private readonly roomStore?: RoomPresenceStore,
    @Optional() private readonly yjs?: YjsService,
  ) {}

  private async fetchProjectSockets(
    server: Server,
    spaceId: string,
  ): Promise<ManagedSocket[]> {
    const projectRoom = PAGES_ROOMS.project(spaceId);
    if (typeof server.in === 'function') {
      return (await server.in(projectRoom).fetchSockets()) as ManagedSocket[];
    }
    if (typeof server.fetchSockets === 'function') {
      return (await server.fetchSockets()) as ManagedSocket[];
    }
    return [];
  }

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

    this.realtimeAccess.evictCache(projectId, userId);

    try {
      const server = this.gateway?.server;
      if (!server) return;

      const sockets = await this.fetchProjectSockets(server, projectId);
      for (const socket of sockets) {
        const clientUserId = socket.data?.userId;
        const clientSpaceId = socket.data?.spaceId;

        if (clientUserId === userId && clientSpaceId === projectId) {
          socket.emit(PAGES_EVENTS.ACCESS_REVOKED, { spaceId: projectId });

          const activeDocId = socket.data?.activeDocId;
          if (activeDocId) {
            this.gateway.broadcastToDoc?.(
              projectId,
              activeDocId,
              PAGES_EVENTS.USER_LEFT_DOC,
              PresenceMapper.toLeavePresence(userId, socket.id),
              socket.id,
            );
          }

          this.gateway.broadcastToProject?.(
            projectId,
            PAGES_EVENTS.USER_LEFT_PROJECT,
            PresenceMapper.toLeavePresence(userId, socket.id),
            socket.id,
          );

          if (this.roomStore) {
            await this.roomStore
              .removeProjectSession(projectId, socket.id)
              .catch(() => null);
          }

          socket.leave(PAGES_ROOMS.project(projectId));
          if (activeDocId) {
            socket.leave(PAGES_ROOMS.doc(projectId, activeDocId));
          }

          socket.data.spaceId = null;
          socket.data.activeDocId = null;

          if (activeDocId && this.yjs) {
            const docRoom = server.sockets?.adapter?.rooms?.get(
              PAGES_ROOMS.doc(projectId, activeDocId),
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

    this.realtimeAccess.evictCache(projectId, userId);

    try {
      const server = this.gateway?.server;
      if (!server) return;

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

      const sockets = await this.fetchProjectSockets(server, projectId);
      for (const socket of sockets) {
        if (
          socket.data?.userId === userId &&
          socket.data?.spaceId === projectId
        ) {
          socket.emit(PAGES_EVENTS.ACCESS_UPDATED, {
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
      if (server) {
        const sockets = await this.fetchProjectSockets(server, projectId);
        for (const socket of sockets) {
          if (socket.data?.spaceId === projectId) {
            socket.emit(PAGES_EVENTS.ACCESS_REVOKED, {
              spaceId: projectId,
              reason: 'project_deleted',
            });
            const docId = socket.data?.activeDocId;
            socket.leave(PAGES_ROOMS.project(projectId));
            if (docId) {
              socket.leave(PAGES_ROOMS.doc(projectId, docId));
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
