import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import {
  PAGES_EVENTS,
  PAGES_REALTIME_DEFAULTS,
  PAGES_ROOMS,
  PagesRealtimeConfigService,
  isPersonalSpaceAlias,
} from './config';
import type { ClientSocketData, UserPresence } from './types';
import type { CursorUpdateDto, JoinDocDto, JoinProjectDto } from './dto';
import { PresenceMapper, RoomPresenceStore } from './presence';
import { RealtimeAccessService } from './access';
import { YjsService } from './yjs/engine';

export interface ProjectAccess {
  canRead: boolean;
  canWrite: boolean;
  role: string;
}

export function emitToRoom(
  server: Server | undefined,
  room: string,
  event: string,
  payload: unknown,
  excludeSocketId?: string,
): void {
  if (!server) return;
  if (excludeSocketId) {
    server.to(room).except(excludeSocketId).emit(event, payload);
  } else {
    server.to(room).emit(event, payload);
  }
}

@Injectable()
export class PagesSessionService {
  private readonly logger = new Logger(PagesSessionService.name);

  constructor(
    private readonly roomStore: RoomPresenceStore,
    private readonly realtimeAccess: RealtimeAccessService,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly config?: PagesRealtimeConfigService,
  ) {}

  private resolveSpaceId(spaceId: string, userId: string): string {
    if (isPersonalSpaceAlias(spaceId)) {
      return userId;
    }
    return spaceId;
  }

  private runBackground(
    op: 'evictDoc' | 'flushDoc',
    spaceId: string,
    docId: string,
    fn: () => Promise<unknown>,
  ): void {
    const retryDelayMs =
      this.config?.getSessionConfig?.()?.backgroundRetryDelayMs ??
      PAGES_REALTIME_DEFAULTS.session.backgroundRetryDelayMs;
    void fn().catch((firstErr: unknown) => {
      this.logger.warn(
        `${op} failed for ${spaceId}:${docId}, retrying once: ${(firstErr as Error)?.message}`,
      );
      setTimeout(() => {
        fn().catch((err: unknown) =>
          this.logger.error(
            `${op} retry failed for ${spaceId}:${docId}; relying on idle sweep: ${(err as Error)?.message}`,
          ),
        );
      }, retryDelayMs).unref?.();
    });
  }

  public getClientData(client: Socket): ClientSocketData {
    if (!client.data) {
      client.data = {
        userId: '',
        name: 'Collaborator',
        spaceId: null,
        activeDocId: null,
        authenticated: false,
      } satisfies ClientSocketData;
    }
    return client.data as ClientSocketData;
  }

  public async verifyAccess(
    userId: string,
    spaceId: string,
  ): Promise<ProjectAccess> {
    const resolvedSpaceId = this.resolveSpaceId(spaceId, userId);
    const access = await this.realtimeAccess.getProjectAccess(
      resolvedSpaceId,
      userId,
    );
    if (access.decision === 'unavailable') {
      throw new ServiceUnavailableException(
        'Realtime authorization service temporarily unavailable',
      );
    }
    return {
      canRead: access.canRead,
      canWrite: access.canWrite,
      role: access.role,
    };
  }

  public async joinProject(
    client: Socket,
    dto: JoinProjectDto,
    server: Server | undefined,
  ): Promise<{
    success: true;
    projectPresence: UserPresence[];
    access: ProjectAccess;
  }> {
    const clientData = this.getClientData(client);
    const userId = clientData.userId;
    const targetSpaceId = this.resolveSpaceId(dto.spaceId, userId);

    const prevSpaceId = clientData.spaceId;
    const prevDocId = clientData.activeDocId;
    if (prevSpaceId && prevSpaceId !== targetSpaceId) {
      if (prevDocId) {
        try {
          await this.leaveDoc(client, prevSpaceId, prevDocId, server, {
            leaveSocketRoom: true,
            broadcastLeave: true,
            syncYjsLifecycle: true,
          });
        } catch {
          // Best effort cleanup of previous doc
        }
        clientData.activeDocId = null;
      }
      try {
        await this.leaveProject(client, prevSpaceId, server, {
          leaveSocketRoom: true,
          broadcastLeave: true,
        });
      } catch {
        // Best effort cleanup of previous space
      }
    }

    const access = await this.verifyAccess(userId, targetSpaceId);
    if (!access.canRead) {
      throw new ForbiddenException(
        `User ${userId} lacks permission to access space ${targetSpaceId}`,
      );
    }

    const session: UserPresence = {
      userId,
      socketId: client.id,
      spaceId: targetSpaceId,
      name: clientData.name ?? 'Collaborator',
      color: clientData.color ?? this.roomStore.getDeterministicColor(userId),
      avatar: clientData.avatar ?? null,
      activeDocId: null,
      cursor: null,
      lastHeartbeat: Date.now(),
    };

    await this.roomStore.addProjectSession(session);
    const projectPresence =
      await this.roomStore.getProjectSessions(targetSpaceId);

    clientData.spaceId = targetSpaceId;
    const maybePageId = (dto as { pageId?: string }).pageId;
    if (maybePageId) {
      clientData.pageId = maybePageId;
    }
    await client.join(PAGES_ROOMS.project(targetSpaceId));

    emitToRoom(
      server,
      PAGES_ROOMS.project(targetSpaceId),
      PAGES_EVENTS.USER_JOINED_PROJECT,
      PresenceMapper.toPublicPresence(clientData, client.id),
      client.id,
    );

    return {
      success: true,
      projectPresence,
      access,
    };
  }

  public async leaveProject(
    client: Socket,
    spaceId: string,
    server: Server | undefined,
    options: {
      leaveSocketRoom?: boolean;
      broadcastLeave?: boolean;
    } = {},
  ): Promise<void> {
    const { leaveSocketRoom = true, broadcastLeave = true } = options;
    const clientData = this.getClientData(client);

    await this.roomStore.removeProjectSession(spaceId, client.id);
    if (leaveSocketRoom && typeof client.leave === 'function') {
      await client.leave(PAGES_ROOMS.project(spaceId));
    }
    if (clientData.spaceId === spaceId) {
      clientData.spaceId = null;
    }

    if (broadcastLeave) {
      emitToRoom(
        server,
        PAGES_ROOMS.project(spaceId),
        PAGES_EVENTS.USER_LEFT_PROJECT,
        PresenceMapper.toLeavePresence(clientData.userId, client.id),
        client.id,
      );
    }
  }

  public async joinDoc(
    client: Socket,
    dto: JoinDocDto,
    server: Server | undefined,
  ): Promise<{
    success: boolean;
    docPresence?: UserPresence[];
    error?: string;
    code?: string;
  }> {
    const clientData = this.getClientData(client);
    if (clientData.spaceId && clientData.spaceId !== dto.spaceId) {
      return {
        success: false,
        error: 'Must join space before joining doc',
        code: 'ACCESS_DENIED',
      };
    }

    const prevDocId = clientData.activeDocId;
    const prevSpaceId = clientData.spaceId || dto.spaceId;
    if (prevDocId && (prevDocId !== dto.docId || prevSpaceId !== dto.spaceId)) {
      await this.leaveDoc(client, prevSpaceId, prevDocId, server, {
        leaveSocketRoom: true,
        broadcastLeave: true,
        syncYjsLifecycle: true,
      });
    }

    const existingSession = this.roomStore.getSession(client.id);
    if (!existingSession) {
      throw new NotFoundException(
        `Session ${client.id} not found in space ${dto.spaceId}`,
      );
    }

    const docPresence = await this.roomStore.joinDocRoom(
      dto.spaceId,
      dto.docId,
      client.id,
    );
    clientData.activeDocId = dto.docId;
    clientData.spaceId = dto.spaceId;
    await client.join(PAGES_ROOMS.doc(dto.spaceId, dto.docId));

    if (this.yjs) {
      await this.yjs.getOrCreateDoc(dto.spaceId, dto.docId);
    }

    emitToRoom(
      server,
      PAGES_ROOMS.doc(dto.spaceId, dto.docId),
      PAGES_EVENTS.USER_JOINED_DOC,
      PresenceMapper.toPublicPresence(clientData, client.id),
      client.id,
    );

    return {
      success: true,
      docPresence,
    };
  }

  public async leaveDoc(
    client: Socket,
    spaceId: string,
    docId: string,
    server: Server | undefined,
    options: {
      leaveSocketRoom?: boolean;
      broadcastLeave?: boolean;
      syncYjsLifecycle?: boolean;
    } = {},
  ): Promise<void> {
    const {
      leaveSocketRoom = true,
      broadcastLeave = true,
      syncYjsLifecycle = false,
    } = options;
    const clientData = this.getClientData(client);

    await this.roomStore.leaveDocRoom(spaceId, docId, client.id);
    if (leaveSocketRoom && typeof client.leave === 'function') {
      await client.leave(PAGES_ROOMS.doc(spaceId, docId));
    }
    if (clientData.activeDocId === docId) {
      clientData.activeDocId = null;
    }

    if (broadcastLeave) {
      emitToRoom(
        server,
        PAGES_ROOMS.doc(spaceId, docId),
        PAGES_EVENTS.USER_LEFT_DOC,
        PresenceMapper.toLeavePresence(clientData.userId, client.id),
        client.id,
      );
    }

    if (syncYjsLifecycle && this.yjs) {
      const adapterRooms =
        (
          server as unknown as {
            adapter?: { rooms?: Map<string, Set<string>> };
          }
        )?.adapter?.rooms ?? server?.sockets?.adapter?.rooms;
      const room = adapterRooms?.get?.(PAGES_ROOMS.doc(spaceId, docId));
      if (!room || room.size === 0) {
        this.runBackground('evictDoc', spaceId, docId, () =>
          this.yjs!.evictDoc(spaceId, docId),
        );
      } else {
        this.runBackground('flushDoc', spaceId, docId, () =>
          this.yjs!.flushDoc(spaceId, docId),
        );
      }
    }
  }

  public async updateCursor(
    client: Socket,
    dto: CursorUpdateDto,
    server: Server | undefined,
  ): Promise<{ success: boolean; presence?: UserPresence | null }> {
    const clientData = this.getClientData(client);
    const spaceId = dto.spaceId || clientData.spaceId;
    const docId = dto.docId || clientData.activeDocId;
    if (!spaceId || !docId) {
      return { success: false };
    }

    const updated = await this.roomStore.updateSessionCursor(
      spaceId,
      docId,
      client.id,
      dto.cursor,
    );

    if (updated) {
      emitToRoom(
        server,
        PAGES_ROOMS.doc(spaceId, docId),
        PAGES_EVENTS.DOC_CURSOR,
        {
          docId,
          userId: clientData.userId,
          socketId: client.id,
          name: clientData.name,
          color: clientData.color,
          avatar: clientData.avatar,
          cursor: updated.cursor,
        },
        client.id,
      );
    }

    return { success: true, presence: updated };
  }

  public async handleDisconnect(
    client: Socket,
    server: Server | undefined,
  ): Promise<void> {
    const clientData = this.getClientData(client);
    const { spaceId, activeDocId } = clientData;

    if (spaceId && activeDocId) {
      try {
        await this.leaveDoc(client, spaceId, activeDocId, server, {
          leaveSocketRoom: false,
          broadcastLeave: true,
          syncYjsLifecycle: true,
        });
      } catch (err) {
        this.logger.warn(
          `Error on doc cleanup during disconnect ${client.id}: ${String(err)}`,
        );
      }
    }

    if (spaceId) {
      try {
        await this.leaveProject(client, spaceId, server, {
          leaveSocketRoom: false,
          broadcastLeave: true,
        });
      } catch (err) {
        this.logger.warn(
          `Error on space disconnect ${client.id}: ${String(err)}`,
        );
      }
    }
  }

  public async getProjectPresence(spaceId: string): Promise<UserPresence[]> {
    return this.roomStore.getProjectSessions(spaceId);
  }

  public async getDocPresence(
    spaceId: string,
    docId: string,
  ): Promise<UserPresence[]> {
    return this.roomStore.getDocSessions(spaceId, docId);
  }
}
