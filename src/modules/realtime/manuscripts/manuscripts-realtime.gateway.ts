/**
 * realtime/realtime.gateway.ts
 * Real-Time WebSocket Gateway for Manuscripts LaTeX collaborative editing & cursor awareness.
 */

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
import { Logger, Injectable, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { JoinProjectUseCase } from './core/use-cases/join-project.use-case';
import { LeaveProjectUseCase } from './core/use-cases/leave-project.use-case';
import { JoinDocUseCase } from './core/use-cases/join-doc.use-case';
import { LeaveDocUseCase } from './core/use-cases/leave-doc.use-case';
import { SendDocUpdateUseCase } from './core/use-cases/send-doc-update.use-case';
import { BroadcastCursorUseCase } from './core/use-cases/broadcast-cursor.use-case';
import { SocketIoBroadcasterAdapter } from './core/adapters/broadcast/socket-io-broadcaster.adapter';

import {
  JoinProjectDto,
  JoinDocDto,
  LeaveDocDto,
  SendUpdateDto,
  CursorUpdateDto,
} from './dto/client-event.dto';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/manuscripts',
})
export class ManuscriptRealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ManuscriptRealtimeGateway.name);

  constructor(
    private readonly joinProjectUseCase: JoinProjectUseCase,
    private readonly leaveProjectUseCase: LeaveProjectUseCase,
    private readonly joinDocUseCase: JoinDocUseCase,
    private readonly leaveDocUseCase: LeaveDocUseCase,
    private readonly sendDocUpdateUseCase: SendDocUpdateUseCase,
    private readonly broadcastCursorUseCase: BroadcastCursorUseCase,
    private readonly broadcasterAdapter: SocketIoBroadcasterAdapter,
    @Optional() private readonly jwtService?: JwtService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  public afterInit(server: Server): void {
    this.broadcasterAdapter.setServer(server);
    this.logger.log('Manuscripts Real-Time WebSocket Gateway initialized.');
  }

  public async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    let userId = (client.handshake.auth?.userId as string) || (client.handshake.query?.userId as string);
    let userName = (client.handshake.auth?.name as string) || (client.handshake.query?.name as string);

    if (token && this.jwtService) {
      try {
        const secret =
          this.configService?.get<string>('JWT_SECRET') || process.env.JWT_SECRET || 'secret';
        const payload = await this.jwtService.verifyAsync(token, { secret });
        userId = payload.sub || payload.id || userId;
        userName = payload.name || payload.email || userName;
      } catch (err) {
        this.logger.debug(`Socket ${client.id} provided invalid token, falling back to handshake auth.`);
      }
    }

    if (!userId) {
      // In dev or test mode, generate an anonymous collaborator ID if not specified
      userId = `anon-${client.id.substring(0, 8)}`;
    }

    client.data = {
      userId,
      name: userName || 'Collaborator',
      color: client.handshake.auth?.color,
      avatar: client.handshake.auth?.avatar,
      projectId: null,
      activeDocId: null,
    };

    this.logger.debug(`Socket connected: ${client.id} (user: ${userId})`);
  }

  public async handleDisconnect(client: Socket): Promise<void> {
    const projectId = client.data?.projectId;
    if (projectId) {
      try {
        await this.leaveProjectUseCase.execute({
          projectId,
          socketId: client.id,
        });
      } catch (err) {
        this.logger.warn(`Error on socket disconnect ${client.id}: ${err}`);
      }
    }
    this.logger.debug(`Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('project:join')
  public async handleJoinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      const userId = client.data?.userId || `anon-${client.id.substring(0, 8)}`;
      const result = await this.joinProjectUseCase.execute({
        projectId: dto.projectId,
        userId,
        socketId: client.id,
        name: client.data?.name,
        color: client.data?.color,
        avatar: client.data?.avatar,
      });

      client.data.projectId = dto.projectId;
      client.join(`project:${dto.projectId}`);

      return {
        success: true,
        projectPresence: result.projectPresence.map((p) => p.toJSON()),
        access: result.access,
      };
    } catch (err: any) {
      this.logger.warn(`Join project error for socket ${client.id}: ${err?.message}`);
      return { success: false, error: err?.message };
    }
  }

  @SubscribeMessage('project:leave')
  public async handleLeaveProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinProjectDto,
  ) {
    try {
      await this.leaveProjectUseCase.execute({
        projectId: dto.projectId,
        socketId: client.id,
      });
      client.leave(`project:${dto.projectId}`);
      client.data.projectId = null;
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  }

  @SubscribeMessage('doc:join')
  public async handleJoinDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinDocDto,
  ) {
    try {
      const result = await this.joinDocUseCase.execute({
        projectId: dto.projectId,
        docId: dto.docId,
        socketId: client.id,
      });

      client.data.activeDocId = dto.docId;
      client.join(`doc:${dto.projectId}:${dto.docId}`);

      return {
        success: true,
        docPresence: result.docPresence.map((p) => p.toJSON()),
      };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  }

  @SubscribeMessage('doc:leave')
  public async handleLeaveDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: LeaveDocDto,
  ) {
    try {
      await this.leaveDocUseCase.execute({
        projectId: dto.projectId,
        docId: dto.docId,
        socketId: client.id,
      });

      client.leave(`doc:${dto.projectId}:${dto.docId}`);
      client.data.activeDocId = null;

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  }

  @SubscribeMessage('doc:update')
  public async handleDocUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendUpdateDto,
  ) {
    try {
      const userId = client.data?.userId || 'unknown';
      const result = await this.sendDocUpdateUseCase.execute({
        projectId: dto.projectId,
        docId: dto.docId,
        socketId: client.id,
        userId,
        clientRev: dto.clientRev,
        lines: dto.lines,
        splice: dto.splice,
        debounceMs: dto.debounceMs,
      });

      return {
        success: true,
        serverRev: result.serverRev,
        clientRev: result.clientRev,
        version: result.version,
        inFlightSeq: result.inFlightSeq,
      };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  }

  @SubscribeMessage('doc:cursor')
  public async handleCursorUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: CursorUpdateDto,
  ) {
    try {
      const presence = await this.broadcastCursorUseCase.execute({
        projectId: dto.projectId,
        docId: dto.docId,
        socketId: client.id,
        cursor: dto.cursor,
      });

      return { success: true, presence: presence ? presence.toJSON() : null };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  }

  private extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    const token = client.handshake.auth?.token;
    if (token && typeof token === 'string') {
      return token;
    }
    return null;
  }
}
