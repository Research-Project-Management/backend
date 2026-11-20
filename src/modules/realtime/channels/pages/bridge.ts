import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { DefaultEventsMap, RemoteSocket, Server } from 'socket.io';
import {
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { RealtimeEventBus } from '../../core/bus';
import { PAGES_EVENTS, PAGES_ROOMS } from './config';
import type { ClientSocketData } from './types';
import { PresenceMapper, RoomPresenceStore } from './presence';
import { PagesGateway } from './gateway';
import { YjsService } from './yjs/engine';
import { RealtimeAccessService } from './access';

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
export class LiveCollaborationAdapter extends LiveCollaborationPort {
  constructor(
    private readonly yjs: YjsService,
    private readonly rooms: RoomPresenceStore,
    @Optional()
    private readonly gateway?: PagesGateway,
  ) {
    super();
  }

  async applyExternalText(
    projectId: string,
    docId: string,
    text: string,
  ): Promise<boolean> {
    const { active, frame } = await this.yjs.applyExternalTextAndSyncRedis(
      projectId,
      docId,
      text,
    );
    if (!active) return false;
    if (frame && this.gateway?.server) {
      this.gateway.server
        .to(PAGES_ROOMS.doc(projectId, docId))
        .emit(PAGES_EVENTS.YJS_SYNC_UPDATE, {
          spaceId: projectId,
          docId,
          data: frame,
        });
    }
    return true;
  }

  async getPresence(
    projectId: string,
    docId: string | null,
  ): Promise<LivePresenceUser[]> {
    const sessions = docId
      ? await this.rooms.getDocSessions(projectId, docId)
      : await this.rooms.getProjectSessions(projectId);

    return sessions.map((p) => ({
      id: p.userId,
      userId: p.userId,
      name: p.name ?? 'Collaborator',
      color: p.color ?? '#3B82F6',
      avatar: p.avatar ?? null,
      fileId: p.activeDocId ?? null,
      cursor: p.cursor as unknown as Record<string, unknown> | null,
      lastSeen: p.lastHeartbeat,
    }));
  }

  async flushDocs(projectId: string, docIds: string[]): Promise<string[]> {
    if (!docIds || docIds.length === 0) {
      return await this.yjs.flushProjectDocs(projectId);
    }

    const flushed = new Set<string>();
    for (const docId of docIds) {
      if (this.yjs.isActive(projectId, docId)) {
        await this.yjs.flushDoc(projectId, docId);
        flushed.add(docId);
      }
    }
    return Array.from(flushed);
  }

  async evictDoc(projectId: string, docId: string): Promise<void> {
    if (this.gateway?.server) {
      const room = PAGES_ROOMS.doc(projectId, docId);
      this.gateway.server.to(room).emit(PAGES_EVENTS.DOC_EVICTED, {
        projectId,
        spaceId: projectId,
        docId,
      });
      if (typeof this.gateway.server.in === 'function') {
        try {
          const sockets = await this.gateway.server.in(room).fetchSockets();
          for (const socket of sockets) {
            const socketData = socket.data as ClientSocketData | undefined;
            if (socketData?.activeDocId === docId) {
              socketData.activeDocId = null;
            }
            socket.leave(room);
            await this.rooms
              .leaveDocRoom(projectId, docId, socket.id)
              .catch(() => {});
          }
        } catch {
          // Best effort room kick
        }
      }
    }
    await this.yjs.evictDoc(projectId, docId, { skipFlush: true });
  }
}

@Injectable()
export class PagesDomainEventsListener
  implements OnModuleInit, OnModuleDestroy
{
  private unsubscribeBus?: () => void;

  constructor(
    @Optional() private readonly pagesGateway?: PagesGateway,
    @Optional() private readonly realtimeBus?: RealtimeEventBus,
  ) {}

  public onModuleInit(): void {
    if (!this.realtimeBus) {
      return;
    }

    this.unsubscribeBus = this.realtimeBus.subscribe((envelope) => {
      if (envelope.type === 'pages:project-event') {
        this.pagesGateway?.broadcastToProjectLocal(
          envelope.projectId,
          envelope.event,
          envelope.payload,
        );
      }
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
  }

  public handleFileTreeChangeEvent(payload: {
    projectId: string;
    change: { action: string; node: unknown };
  }): void {
    if (!payload?.projectId || !payload?.change) return;
    this.pagesGateway?.broadcastToProject(
      payload.projectId,
      PAGES_EVENTS.FILE_TREE_UPDATE,
      payload.change,
    );
  }

  public handleProjectEvent(payload: {
    projectId: string;
    event: string;
    payload: unknown;
  }): void {
    if (!payload?.projectId || !payload?.event) return;
    this.pagesGateway?.broadcastToProject(
      payload.projectId,
      payload.event,
      payload.payload,
    );
  }
}

@Injectable()
export class AccessRevocationListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessRevocationListener.name);
  private unsubscribeBus?: () => void;

  constructor(
    private readonly realtimeAccess: RealtimeAccessService,
    private readonly gateway: PagesGateway,
    @Optional() private readonly roomStore?: RoomPresenceStore,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly realtimeBus?: RealtimeEventBus,
  ) {}

  public onModuleInit(): void {
    if (!this.realtimeBus) {
      return;
    }

    this.unsubscribeBus = this.realtimeBus.subscribe(async (envelope) => {
      if (envelope.type === 'member:removed') {
        await this.handleMemberRemoved({
          projectId: envelope.projectId,
          userId: envelope.userId,
        });
      } else if (envelope.type === 'member:updated') {
        await this.handleMemberUpdated({
          projectId: envelope.projectId,
          userId: envelope.userId,
          role: envelope.role,
        });
      } else if (envelope.type === 'ownership:transferred') {
        this.handleOwnershipTransferred({
          projectId: envelope.projectId,
          previousOwnerId: envelope.previousOwnerId,
          newOwnerId: envelope.newOwnerId,
        });
      } else if (envelope.type === 'project:deleted') {
        await this.handleProjectDeleted({ projectId: envelope.projectId });
      }
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
  }

  private async fetchProjectSockets(
    server: Server,
    spaceId: string,
  ): Promise<ManagedSocket[]> {
    const localServer =
      (server as unknown as { local?: Server }).local ?? server;
    const projectRoom = PAGES_ROOMS.project(spaceId);
    if (typeof localServer.in === 'function') {
      return (await localServer
        .in(projectRoom)
        .fetchSockets()) as ManagedSocket[];
    }
    if (typeof localServer.fetchSockets === 'function') {
      return (await localServer.fetchSockets()) as ManagedSocket[];
    }
    return [];
  }

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
