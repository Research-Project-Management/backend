import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import {
  Logger,
  Injectable,
  Optional,
  UseGuards,
  UsePipes,
  UseFilters,
  ValidationPipe,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';

import { WsAuthService } from '../core/ws-auth.guard';
import { createWsConnectionMiddleware } from '../core/ws-connection.middleware';
import { WsAccess } from '../core/ws-access.decorator';
import { WsAccessGuard } from '../core/ws-access.guard';
import { WsAllExceptionsFilter } from '../core/ws-exception.filter';
import { WsRateLimiter } from '../core/ws-rate-limiter';
import { ManuscriptsService } from './manuscripts.service';
import { YjsService } from './yjs.service';
import { ChatService } from './chat.service';
import { PresenceMapper } from './presence.mapper';
import {
  JoinProjectDto,
  JoinDocDto,
  LeaveDocDto,
  SendUpdateDto,
  CursorUpdateDto,
  DocSyncDto,
  ProjectChatSendDto,
  ProjectChatHistoryDto,
} from './dto/events.dto';
import { ClientSocketData } from './types/presence.type';
import {
  REALTIME_EVENTS,
  REALTIME_NAMESPACES,
} from '../core/realtime.constant';
import { isOriginAllowed } from '@/core/http/setup/allowed-origins';

@Injectable()
@UseGuards(WsAccessGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
@UseFilters(new WsAllExceptionsFilter())
@WebSocketGateway({
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
  },
  namespace: REALTIME_NAMESPACES.MANUSCRIPTS,
})
export class ManuscriptsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ManuscriptsGateway.name);

  /**
   * Runs a fire-and-forget Yjs persistence op. Failures are logged (never swallowed)
   * and retried once, because a lost flush on last-user leave drops edits until the next sweep.
   */
  private runBackground(
    op: 'evictDoc' | 'flushDoc',
    projectId: string,
    docId: string,
    fn: () => Promise<unknown>,
  ): void {
    void fn().catch((firstErr: unknown) => {
      this.logger.warn(
        `${op} failed for ${projectId}:${docId}, retrying once: ${(firstErr as Error)?.message}`,
      );
      setTimeout(() => {
        fn().catch((err: unknown) =>
          this.logger.error(
            `${op} retry failed for ${projectId}:${docId}; relying on idle sweep: ${(err as Error)?.message}`,
          ),
        );
      }, 1000).unref?.();
    });
  }

  constructor(
    private readonly service: ManuscriptsService,
    private readonly chatService: ChatService,
    private readonly authService: WsAuthService,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly rateLimiter?: WsRateLimiter,
  ) {}

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
    this.yjs?.setServer(server);
    this.logger.log(
      'Manuscripts WebSocket Gateway initialized (/manuscripts).',
    );
  }

  private getClientData(client: Socket): ClientSocketData {
    if (!client.data) {
      client.data = {
        userId: '',
        name: 'Collaborator',
        projectId: null,
        activeDocId: null,
        authenticated: false,
      };
    }
    return client.data as ClientSocketData;
  }

  public async handleConnection(client: Socket): Promise<void> {
    try {
      if (!client.data?.authenticated) {
        const session = await this.authService.authenticateSocket(client);
        client.data = {
          ...client.data,
          ...session,
          projectId: null,
          activeDocId: null,
        } satisfies ClientSocketData;
      }

      this.logger.debug(
        `Socket connected: ${client.id} (user: ${client.data.userId})`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Unauthorized manuscript socket connection on ${client.id}: ${(err as Error)?.message}`,
      );
      client.disconnect(true);
    }
  }

  public async handleDisconnect(client: Socket): Promise<void> {
    const clientData = this.getClientData(client);
    const { projectId, activeDocId } = clientData;

    if (projectId && activeDocId) {
      try {
        await this.leaveActiveDocSession(client, projectId, activeDocId, {
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

    if (projectId) {
      try {
        await this.leaveActiveProjectSession(client, projectId, {
          leaveSocketRoom: false,
          broadcastLeave: true,
        });
      } catch (err) {
        this.logger.warn(
          `Error on project disconnect ${client.id}: ${String(err)}`,
        );
      }
    }

    if (this.rateLimiter) {
      this.rateLimiter.cleanupSocket(client.id);
    }

    this.logger.debug(`Socket disconnected: ${client.id}`);
  }

  /**
   * Mediator Pattern: Centralizes document room departure, presence cleanup,
   * peer notification, and Yjs flush/eviction lifecycle across all disconnect/switch flows.
   */
  private async leaveActiveDocSession(
    client: Socket,
    projectId: string,
    docId: string,
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

    await this.service.leaveDoc(projectId, docId, client.id);
    if (leaveSocketRoom && typeof client.leave === 'function') {
      await client.leave(`doc:${projectId}:${docId}`);
    }
    if (clientData.activeDocId === docId) {
      clientData.activeDocId = null;
    }

    if (broadcastLeave) {
      this.broadcastToDoc(
        projectId,
        docId,
        REALTIME_EVENTS.USER_LEFT_DOC,
        PresenceMapper.toLeavePresence(clientData.userId, client.id),
        client.id,
      );
    }

    if (syncYjsLifecycle && this.yjs) {
      const adapterRooms =
        (
          this.server as unknown as {
            adapter?: { rooms?: Map<string, Set<string>> };
          }
        )?.adapter?.rooms ?? this.server?.sockets?.adapter?.rooms;
      const room = adapterRooms?.get(`doc:${projectId}:${docId}`);
      if (!room || room.size === 0) {
        this.runBackground('evictDoc', projectId, docId, () =>
          this.yjs!.evictDoc(projectId, docId),
        );
      } else {
        this.runBackground('flushDoc', projectId, docId, () =>
          this.yjs!.flushDoc(projectId, docId),
        );
      }
    }
  }

  /**
   * Mediator Pattern: Centralizes project room departure, presence cleanup, and peer notification.
   */
  private async leaveActiveProjectSession(
    client: Socket,
    projectId: string,
    options: {
      leaveSocketRoom?: boolean;
      broadcastLeave?: boolean;
    } = {},
  ): Promise<void> {
    const { leaveSocketRoom = true, broadcastLeave = true } = options;
    const clientData = this.getClientData(client);

    await this.service.leaveProject(projectId, client.id);
    if (leaveSocketRoom && typeof client.leave === 'function') {
      await client.leave(`project:${projectId}`);
    }
    if (clientData.projectId === projectId) {
      clientData.projectId = null;
    }

    if (broadcastLeave) {
      this.broadcastToProject(
        projectId,
        REALTIME_EVENTS.USER_LEFT_PROJECT,
        PresenceMapper.toLeavePresence(clientData.userId, client.id),
        client.id,
      );
    }
  }

  @WsAccess('member')
  @SubscribeMessage(REALTIME_EVENTS.PROJECT_JOIN)
  public async handleJoinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      const userId = clientData.userId;

      const prevProjectId = clientData.projectId;
      const prevDocId = clientData.activeDocId;
      if (prevProjectId && prevProjectId !== dto.projectId) {
        if (prevDocId) {
          try {
            await this.leaveActiveDocSession(client, prevProjectId, prevDocId, {
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
          await this.leaveActiveProjectSession(client, prevProjectId, {
            leaveSocketRoom: true,
            broadcastLeave: true,
          });
        } catch {
          // Best effort cleanup of previous project
        }
      }

      const result = await this.service.joinProject({
        projectId: dto.projectId,
        userId,
        socketId: client.id,
        name: clientData.name,
        color: clientData.color,
        avatar: clientData.avatar,
      });

      clientData.projectId = dto.projectId;
      await client.join(`project:${dto.projectId}`);

      // Broadcast join to peers
      this.broadcastToProject(
        dto.projectId,
        REALTIME_EVENTS.USER_JOINED_PROJECT,
        PresenceMapper.toPublicPresence(clientData, client.id),
        client.id,
      );

      return {
        success: true,
        projectPresence: result.projectPresence,
        access: result.access,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Join project error for socket ${client.id}: ${message}`,
      );
      return { success: false, error: message };
    }
  }

  @WsAccess('none')
  @SubscribeMessage(REALTIME_EVENTS.PROJECT_LEAVE)
  public async handleLeaveProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      // Unjoined sockets must NOT broadcast leave events (RT-03)
      if (!clientData.projectId || clientData.projectId !== dto.projectId) {
        return { success: true };
      }

      await this.leaveActiveProjectSession(client, dto.projectId, {
        leaveSocketRoom: true,
        broadcastLeave: true,
      });

      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @WsAccess('read')
  @SubscribeMessage(REALTIME_EVENTS.DOC_JOIN)
  public async handleJoinDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinDocDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      if (clientData.projectId && clientData.projectId !== dto.projectId) {
        return {
          success: false,
          error: 'Must join project before joining doc',
          code: 'ACCESS_DENIED',
        };
      }

      const prevDocId = clientData.activeDocId;
      const prevProjectId = clientData.projectId || dto.projectId;

      if (
        prevDocId &&
        (prevDocId !== dto.docId || prevProjectId !== dto.projectId)
      ) {
        await this.leaveActiveDocSession(client, prevProjectId, prevDocId, {
          leaveSocketRoom: true,
          broadcastLeave: true,
          syncYjsLifecycle: true,
        });
      }

      const result = await this.service.joinDoc(
        dto.projectId,
        dto.docId,
        client.id,
      );
      clientData.activeDocId = dto.docId;
      clientData.projectId = dto.projectId;
      await client.join(`doc:${dto.projectId}:${dto.docId}`);

      if (this.yjs) {
        await this.yjs.getOrCreateDoc(dto.projectId, dto.docId);
      }

      this.broadcastToDoc(
        dto.projectId,
        dto.docId,
        REALTIME_EVENTS.USER_JOINED_DOC,
        PresenceMapper.toPublicPresence(clientData, client.id),
        client.id,
      );

      return {
        success: true,
        docPresence: result.docPresence,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @WsAccess('none')
  @SubscribeMessage(REALTIME_EVENTS.DOC_LEAVE)
  public async handleLeaveDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: LeaveDocDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      // Unjoined sockets must NOT broadcast leave events (RT-03)
      if (
        !clientData.projectId ||
        clientData.projectId !== dto.projectId ||
        !clientData.activeDocId ||
        clientData.activeDocId !== dto.docId
      ) {
        return { success: true };
      }

      await this.leaveActiveDocSession(client, dto.projectId, dto.docId, {
        leaveSocketRoom: true,
        broadcastLeave: true,
        syncYjsLifecycle: true,
      });

      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @WsAccess('write')
  @SubscribeMessage(REALTIME_EVENTS.DOC_UPDATE)
  public async handleDocUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendUpdateDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      const projectId = dto.projectId || clientData.projectId;
      const docId = dto.docId || clientData.activeDocId;
      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const updateResult = await this.service.applyDocUpdate(
        { ...dto, projectId, docId },
        clientData.userId,
      );

      if (updateResult.yjsFrame) {
        this.broadcastToDoc(
          projectId,
          docId,
          REALTIME_EVENTS.YJS_SYNC_UPDATE,
          {
            projectId,
            docId,
            data: updateResult.yjsFrame,
          },
          client.id,
        );
      }

      // Broadcast update to peers in room (exclude sender)
      this.broadcastToDoc(
        projectId,
        docId,
        REALTIME_EVENTS.DOC_UPDATE,
        {
          docId,
          clientRev: updateResult.clientRev,
          serverRev: updateResult.serverRev,
          version: updateResult.version,
          inFlightSeq: updateResult.inFlightSeq,
          lines: dto.lines,
          splice: dto.splice,
          userId: clientData.userId,
        },
        client.id,
      );

      // Send ACK back to sender
      client.emit(REALTIME_EVENTS.DOC_UPDATE_ACK, {
        docId,
        clientRev: updateResult.clientRev,
        serverRev: updateResult.serverRev,
        version: updateResult.version,
        inFlightSeq: updateResult.inFlightSeq,
      });

      return {
        success: true,
        serverRev: updateResult.serverRev,
        clientRev: updateResult.clientRev,
        version: updateResult.version,
        inFlightSeq: updateResult.inFlightSeq,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @WsAccess('read')
  @SubscribeMessage(REALTIME_EVENTS.DOC_CURSOR)
  public async handleCursorUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: CursorUpdateDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      const projectId = dto.projectId || clientData.projectId;
      const docId = dto.docId || clientData.activeDocId;
      if (!projectId || !docId) return { success: false };

      const updated = await this.service.updateCursor(
        projectId,
        docId,
        client.id,
        dto.cursor,
      );

      if (updated) {
        this.broadcastToDoc(
          projectId,
          docId,
          REALTIME_EVENTS.DOC_CURSOR,
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
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- Binary Yjs Handlers ---

  @WsAccess('read')
  @SubscribeMessage(REALTIME_EVENTS.YJS_SYNC_STEP_1)
  public async handleSyncStep1(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return { success: false, error: 'YjsService unavailable' };
    try {
      const reply = await this.yjs.handleSyncStep1(
        dto.projectId,
        dto.docId,
        dto.data as Uint8Array,
      );
      if (reply.length > 0) {
        client.emit(REALTIME_EVENTS.YJS_SYNC_STEP_2, {
          docId: dto.docId,
          data: reply,
        });
      }
      return { success: true, data: reply };
    } catch (err) {
      this.logger.warn(`Yjs SyncStep1 error: ${err}`);
      return { success: false, error: (err as Error)?.message || String(err) };
    }
  }

  @WsAccess('write')
  @SubscribeMessage(REALTIME_EVENTS.YJS_SYNC_STEP_2)
  public async handleSyncStep2(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return { success: false };
    try {
      await this.yjs.handleSyncStep2(
        dto.projectId,
        dto.docId,
        dto.data as Uint8Array,
        client.id,
      );
      return { success: true };
    } catch (err) {
      this.logger.warn(`Yjs SyncStep2 error: ${err}`);
      return { success: false, error: (err as Error)?.message || String(err) };
    }
  }

  @WsAccess('write')
  @SubscribeMessage(REALTIME_EVENTS.YJS_SYNC_UPDATE)
  public async handleSyncUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return { success: false };
    try {
      const updateFrame = await this.yjs.handleSyncUpdate(
        dto.projectId,
        dto.docId,
        dto.data as Uint8Array,
        client.id,
      );

      if (updateFrame.length > 0) {
        const payload = {
          projectId: dto.projectId,
          docId: dto.docId,
          data: updateFrame,
        };
        this.broadcastToDoc(
          dto.projectId,
          dto.docId,
          REALTIME_EVENTS.YJS_SYNC_UPDATE,
          payload,
          client.id,
        );
      }
      return { success: true };
    } catch (err) {
      this.logger.warn(`Yjs SyncUpdate error: ${err}`);
      return { success: false, error: (err as Error)?.message || String(err) };
    }
  }

  // --- Project Chat Handlers ---

  @WsAccess('member')
  @SubscribeMessage(REALTIME_EVENTS.CHAT_SEND)
  public handleChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: ProjectChatSendDto,
  ) {
    const clientData = this.getClientData(client);
    const message = this.chatService.saveMessage(dto, {
      id: clientData.userId,
      name: clientData.name,
      color: clientData.color,
      avatar: clientData.avatar,
    });

    this.broadcastToProject(dto.projectId, REALTIME_EVENTS.CHAT_NEW, message);
    return { success: true, message };
  }

  @WsAccess('member')
  @SubscribeMessage(REALTIME_EVENTS.CHAT_HISTORY)
  public async handleChatHistory(
    @ConnectedSocket() _client: Socket,
    @MessageBody() dto: ProjectChatHistoryDto,
  ) {
    const messages = await this.chatService.getHistoryAsync(dto.projectId);
    return { success: true, messages };
  }

  // --- Broadcaster Helpers ---

  public broadcastToProject(
    projectId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ): void {
    if (!this.server) return;
    const room = `project:${projectId}`;
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit(event, payload);
    } else {
      this.server.to(room).emit(event, payload);
    }
  }

  public broadcastToDoc(
    projectId: string,
    docId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ): void {
    if (!this.server) return;
    const room = `doc:${projectId}:${docId}`;
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit(event, payload);
    } else {
      this.server.to(room).emit(event, payload);
    }
  }
}
