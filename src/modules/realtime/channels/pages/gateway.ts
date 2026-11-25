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

import { REALTIME_NAMESPACES, createWsCorsOptions } from '../../core/config';
import { WsAuthService, createWsConnectionMiddleware } from '../../core/auth';
import { WsAllExceptionsFilter } from '../../core/errors';
import { WsRateLimiter } from '../../core/rate-limit';
import { emitToLocalRoom } from '../../core/rooms';
import { PAGES_EVENTS, PAGES_ROOMS } from './config';
import { WsAccess, WsAccessGuard } from './guard';
import { PagesSessionService, emitToRoom } from './session';
import { YjsService } from './yjs/engine';
import type { ClientSocketData } from './types';
import {
  JoinProjectDto,
  JoinDocDto,
  LeaveDocDto,
  CursorUpdateDto,
  DocSyncDto,
} from './dto';

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
  cors: createWsCorsOptions(),
  namespace: REALTIME_NAMESPACES.PAGES,
})
export class PagesGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(PagesGateway.name);

  constructor(
    private readonly sessionService: PagesSessionService,
    private readonly authService: WsAuthService,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly rateLimiter?: WsRateLimiter,
  ) {}

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
    this.yjs?.setServer(server);
    this.logger.log('Pages WebSocket Gateway initialized (/pages).');
  }

  public async handleConnection(client: Socket): Promise<void> {
    try {
      const existingData = client.data as Partial<ClientSocketData> | undefined;
      if (!existingData?.authenticated) {
        const session = await this.authService.authenticateSocket(client);
        client.data = {
          ...existingData,
          ...session,
          spaceId: existingData?.spaceId ?? null,
          activeDocId: existingData?.activeDocId ?? null,
        } satisfies ClientSocketData;
      } else {
        existingData.spaceId = existingData.spaceId ?? null;
        existingData.activeDocId = existingData.activeDocId ?? null;
      }

      this.logger.debug(
        `Socket connected: ${client.id} (user: ${(client.data as ClientSocketData).userId})`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Unauthorized page socket connection on ${client.id}: ${(err as Error)?.message}`,
      );
      client.disconnect(true);
    }
  }

  public async handleDisconnect(client: Socket): Promise<void> {
    await this.sessionService.handleDisconnect(client, this.server);
    this.rateLimiter?.cleanupSocket(client.id);
    this.logger.debug(`Socket disconnected: ${client.id}`);
  }

  @WsAccess('member')
  @SubscribeMessage(PAGES_EVENTS.PROJECT_JOIN)
  public async handleJoinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      return await this.sessionService.joinProject(client, dto, this.server);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Join project error for socket ${client.id}: ${message}`,
      );
      return { success: false, error: message };
    }
  }

  @WsAccess('none')
  @SubscribeMessage(PAGES_EVENTS.PROJECT_LEAVE)
  public async handleLeaveProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      const clientData = this.sessionService.getClientData(client);
      if (!clientData.spaceId || clientData.spaceId !== dto.spaceId) {
        return { success: true };
      }
      await this.sessionService.leaveProject(client, dto.spaceId, this.server, {
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
  @SubscribeMessage(PAGES_EVENTS.DOC_JOIN)
  public async handleJoinDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinDocDto,
  ) {
    try {
      return await this.sessionService.joinDoc(client, dto, this.server);
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @WsAccess('none')
  @SubscribeMessage(PAGES_EVENTS.DOC_LEAVE)
  public async handleLeaveDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: LeaveDocDto,
  ) {
    try {
      const clientData = this.sessionService.getClientData(client);
      if (
        !clientData.spaceId ||
        clientData.spaceId !== dto.spaceId ||
        !clientData.activeDocId ||
        clientData.activeDocId !== dto.docId
      ) {
        return { success: true };
      }
      await this.sessionService.leaveDoc(
        client,
        dto.spaceId,
        dto.docId,
        this.server,
        {
          leaveSocketRoom: true,
          broadcastLeave: true,
          syncYjsLifecycle: true,
        },
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
  @SubscribeMessage(PAGES_EVENTS.DOC_CURSOR)
  public async handleCursorUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: CursorUpdateDto,
  ) {
    try {
      return await this.sessionService.updateCursor(client, dto, this.server);
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- Binary Yjs CRDT Handlers ---

  @WsAccess('read')
  @SubscribeMessage(PAGES_EVENTS.YJS_SYNC_STEP_1)
  public async handleSyncStep1(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return { success: false, error: 'YjsService unavailable' };
    try {
      const reply = await this.yjs.handleSyncStep1(
        dto.spaceId,
        dto.docId,
        dto.data as Uint8Array,
      );
      return { success: true, data: reply };
    } catch (err) {
      this.logger.warn(`Yjs SyncStep1 error: ${String(err)}`);
      return { success: false, error: (err as Error)?.message || String(err) };
    }
  }

  @WsAccess('write')
  @SubscribeMessage(PAGES_EVENTS.YJS_SYNC_STEP_2)
  public async handleSyncStep2(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return { success: false };
    try {
      await this.yjs.handleSyncStep2(
        dto.spaceId,
        dto.docId,
        dto.data as Uint8Array,
        client.id,
      );
      return { success: true };
    } catch (err) {
      this.logger.warn(`Yjs SyncStep2 error: ${String(err)}`);
      return { success: false, error: (err as Error)?.message || String(err) };
    }
  }

  @WsAccess('write')
  @SubscribeMessage(PAGES_EVENTS.YJS_SYNC_UPDATE)
  public async handleSyncUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjs) return { success: false };
    try {
      const updateFrame = await this.yjs.handleSyncUpdate(
        dto.spaceId,
        dto.docId,
        dto.data as Uint8Array,
        client.id,
      );

      if (updateFrame.length > 0) {
        this.broadcastToDoc(
          dto.spaceId,
          dto.docId,
          PAGES_EVENTS.YJS_SYNC_UPDATE,
          {
            spaceId: dto.spaceId,
            docId: dto.docId,
            data: updateFrame,
          },
          client.id,
        );
      }
      return { success: true };
    } catch (err) {
      this.logger.warn(`Yjs SyncUpdate error: ${String(err)}`);
      return { success: false, error: (err as Error)?.message || String(err) };
    }
  }

  // --- Broadcaster Helpers ---

  public broadcastToProject(
    spaceId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ): void {
    emitToRoom(
      this.server,
      PAGES_ROOMS.project(spaceId),
      event,
      payload,
      excludeSocketId,
    );
  }

  public broadcastToProjectLocal(
    spaceId: string,
    event: string,
    payload: unknown,
  ): void {
    emitToLocalRoom(this.server, PAGES_ROOMS.project(spaceId), event, payload);
  }

  public broadcastToDoc(
    spaceId: string,
    docId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ): void {
    emitToRoom(
      this.server,
      PAGES_ROOMS.doc(spaceId, docId),
      event,
      payload,
      excludeSocketId,
    );
  }
}
