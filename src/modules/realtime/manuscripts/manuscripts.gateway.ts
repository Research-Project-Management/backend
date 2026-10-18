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

  constructor(
    private readonly service: ManuscriptsService,
    private readonly chatService: ChatService,
    private readonly authService: WsAuthService,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly rateLimiter?: WsRateLimiter,
  ) {}

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
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
        await this.service.leaveDoc(projectId, activeDocId, client.id);
        this.broadcastToDoc(
          projectId,
          activeDocId,
          REALTIME_EVENTS.USER_LEFT_DOC,
          PresenceMapper.toLeavePresence(clientData.userId, client.id),
          client.id,
        );

        if (this.yjs) {
          const room = this.server?.sockets?.adapter?.rooms?.get(
            `doc:${projectId}:${activeDocId}`,
          );
          if (!room || room.size === 0) {
            void this.yjs.evictDoc(projectId, activeDocId).catch(() => {});
          } else {
            void this.yjs.flushDoc(projectId, activeDocId).catch(() => {});
          }
        }
      } catch (err) {
        this.logger.warn(
          `Error on doc cleanup during disconnect ${client.id}: ${String(err)}`,
        );
      }
    }

    if (projectId) {
      try {
        await this.service.leaveProject(projectId, client.id);
        this.broadcastToProject(
          projectId,
          REALTIME_EVENTS.USER_LEFT_PROJECT,
          PresenceMapper.toLeavePresence(clientData.userId, client.id),
          client.id,
        );
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

  @WsAccess('member')
  @SubscribeMessage(REALTIME_EVENTS.PROJECT_JOIN)
  public async handleJoinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      const clientData = this.getClientData(client);
      const userId = clientData.userId;

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

      await this.service.leaveProject(dto.projectId, client.id);
      await client.leave(`project:${dto.projectId}`);
      clientData.projectId = null;

      this.broadcastToProject(
        dto.projectId,
        REALTIME_EVENTS.USER_LEFT_PROJECT,
        PresenceMapper.toLeavePresence(clientData.userId, client.id),
        client.id,
      );

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
        await this.service.leaveDoc(prevProjectId, prevDocId, client.id);
        await client.leave(`doc:${prevProjectId}:${prevDocId}`);
        this.broadcastToDoc(
          prevProjectId,
          prevDocId,
          REALTIME_EVENTS.USER_LEFT_DOC,
          PresenceMapper.toLeavePresence(clientData.userId, client.id),
          client.id,
        );
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
        void this.yjs.getOrCreateDoc(dto.projectId, dto.docId).catch(() => {});
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

      await this.service.leaveDoc(dto.projectId, dto.docId, client.id);
      await client.leave(`doc:${dto.projectId}:${dto.docId}`);
      clientData.activeDocId = null;

      this.broadcastToDoc(
        dto.projectId,
        dto.docId,
        REALTIME_EVENTS.USER_LEFT_DOC,
        PresenceMapper.toLeavePresence(clientData.userId, client.id),
        client.id,
      );

      if (this.yjs) {
        const room = this.server?.sockets?.adapter?.rooms?.get(
          `doc:${dto.projectId}:${dto.docId}`,
        );
        if (!room || room.size === 0) {
          void this.yjs.evictDoc(dto.projectId, dto.docId).catch(() => {});
        } else {
          void this.yjs.flushDoc(dto.projectId, dto.docId).catch(() => {});
        }
      }

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

      return { success: true, ...updateResult };
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
    if (!this.yjs) return;
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
    } catch (err) {
      this.logger.warn(`Yjs SyncStep1 error: ${err}`);
    }
  }

  @WsAccess('write')
  @SubscribeMessage(REALTIME_EVENTS.YJS_SYNC_STEP_2)
  public async handleSyncStep2(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return;
    try {
      await this.yjs.handleSyncStep2(
        dto.projectId,
        dto.docId,
        dto.data as Uint8Array,
        client.id,
      );
    } catch (err) {
      this.logger.warn(`Yjs SyncStep2 error: ${err}`);
    }
  }

  @WsAccess('write')
  @SubscribeMessage(REALTIME_EVENTS.YJS_SYNC_UPDATE)
  public async handleSyncUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return;
    try {
      const updateFrame = await this.yjs.handleSyncUpdate(
        dto.projectId,
        dto.docId,
        dto.data as Uint8Array,
        client.id,
      );

      if (updateFrame.length > 0) {
        this.broadcastToDoc(
          dto.projectId,
          dto.docId,
          REALTIME_EVENTS.YJS_SYNC_UPDATE,
          {
            docId: dto.docId,
            data: updateFrame,
          },
          client.id,
        );
      }
    } catch (err) {
      this.logger.warn(`Yjs SyncUpdate error: ${err}`);
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
  public handleChatHistory(
    @ConnectedSocket() _client: Socket,
    @MessageBody() dto: ProjectChatHistoryDto,
  ) {
    const messages = this.chatService.getHistory(dto.projectId);
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
