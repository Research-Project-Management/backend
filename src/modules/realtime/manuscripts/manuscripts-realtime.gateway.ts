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
  DocSyncDto,
  ProjectChatSendDto,
  ProjectChatHistoryDto,
} from './dto/client-event.dto';
import { YjsDocManagerAdapter } from './core/adapters/crdt/yjs-doc-manager.adapter';
import { RedisCacheService } from '@/core';
import { IProjectAccessVerifierPort } from './core/ports/project-access-verifier.port';

export interface ProjectChatMessage {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  userColor?: string;
  userAvatar?: string;
  text: string;
  replyToId?: string;
  createdAt: string;
}

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
  private readonly projectChatStore = new Map<string, ProjectChatMessage[]>();
  private static readonly MAX_CHAT_HISTORY = 200;

  constructor(
    private readonly joinProjectUseCase: JoinProjectUseCase,
    private readonly leaveProjectUseCase: LeaveProjectUseCase,
    private readonly joinDocUseCase: JoinDocUseCase,
    private readonly leaveDocUseCase: LeaveDocUseCase,
    private readonly sendDocUpdateUseCase: SendDocUpdateUseCase,
    private readonly broadcastCursorUseCase: BroadcastCursorUseCase,
    private readonly broadcasterAdapter: SocketIoBroadcasterAdapter,
    @Optional() private readonly yjsDocManager?: YjsDocManagerAdapter,
    @Optional() private readonly jwtService?: JwtService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly redisCache?: RedisCacheService,
    @Optional() private readonly accessVerifier?: IProjectAccessVerifierPort,
  ) {}

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private isRedisReady(): boolean {
    return !!(
      this.redisCache &&
      this.redisCache.isReady() &&
      this.redisCache.getClient()
    );
  }

  public afterInit(server: Server): void {
    this.broadcasterAdapter.setServer(server);
    this.logger.log('Manuscripts Real-Time WebSocket Gateway initialized.');
  }

  public async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    const configuredSecret =
      this.configService?.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
    let userId: string | undefined;
    let userName: string | undefined;
    let tokenRejected = false;

    if (token && this.jwtService) {
      try {
        const secret = configuredSecret || 'secret';
        const payload = await this.jwtService.verifyAsync(token, { secret });
        userId = payload.sub || payload.id;
        userName = payload.name || payload.email;
      } catch {
        tokenRejected = true;
        this.logger.debug(
          `Socket ${client.id} provided invalid JWT token; ignoring unverified handshake userId.`,
        );
      }
    }

    // Only accept handshake userId when no forged token was rejected and no production JWT_SECRET is enforced
    if (!userId && !tokenRejected) {
      const handshakeUserId =
        (client.handshake.auth?.userId as string) ||
        (client.handshake.query?.userId as string);
      if (handshakeUserId && (!configuredSecret || !this.jwtService)) {
        userId = handshakeUserId;
      }
    }

    if (!userName) {
      userName =
        (client.handshake.auth?.name as string) ||
        (client.handshake.query?.name as string);
    }

    if (!userId) {
      userId = `anon-${client.id.substring(0, 8)}`;
    }

    client.data = {
      userId,
      name: userName || 'Collaborator',
      color: client.handshake.auth?.color,
      avatar: client.handshake.auth?.avatar,
      projectId: null,
      activeDocId: null,
      authenticated: !tokenRejected && !userId.startsWith('anon-'),
    };

    this.logger.debug(`Socket connected: ${client.id} (user: ${userId})`);
  }

  public async handleDisconnect(client: Socket): Promise<void> {
    const projectId = client.data?.projectId;
    const activeDocId = client.data?.activeDocId;

    if (projectId && activeDocId) {
      try {
        await this.leaveDocUseCase
          .execute({
            projectId,
            docId: activeDocId,
            socketId: client.id,
          })
          .catch(() => {});

        if (this.yjsDocManager) {
          const room = this.server?.sockets?.adapter?.rooms?.get(
            `doc:${projectId}:${activeDocId}`,
          );
          if (!room || room.size === 0) {
            this.yjsDocManager.evictDoc(projectId, activeDocId).catch(() => {});
          } else {
            this.yjsDocManager.flushDoc(projectId, activeDocId).catch(() => {});
          }
        }
      } catch (err) {
        this.logger.warn(
          `Error on doc cleanup during disconnect ${client.id}: ${err}`,
        );
      }
    }

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
    } catch (err: unknown) {
      const message = this.getErrorMessage(err);
      this.logger.warn(
        `Join project error for socket ${client.id}: ${message}`,
      );
      return { success: false, error: message };
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
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  @SubscribeMessage('doc:join')
  public async handleJoinDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinDocDto,
  ) {
    try {
      const prevDocId = client.data?.activeDocId;
      const prevProjectId = client.data?.projectId || dto.projectId;

      // Automatically leave previous doc if switching files on the same socket
      if (
        prevDocId &&
        (prevDocId !== dto.docId || prevProjectId !== dto.projectId)
      ) {
        await this.leaveDocUseCase
          .execute({
            projectId: prevProjectId,
            docId: prevDocId,
            socketId: client.id,
          })
          .catch(() => {});
        client.leave(`doc:${prevProjectId}:${prevDocId}`);

        if (this.yjsDocManager) {
          const room = this.server?.sockets?.adapter?.rooms?.get(
            `doc:${prevProjectId}:${prevDocId}`,
          );
          if (!room || room.size === 0) {
            this.yjsDocManager
              .evictDoc(prevProjectId, prevDocId)
              .catch(() => {});
          } else {
            this.yjsDocManager
              .flushDoc(prevProjectId, prevDocId)
              .catch(() => {});
          }
        }
      }

      const result = await this.joinDocUseCase.execute({
        projectId: dto.projectId,
        docId: dto.docId,
        socketId: client.id,
      });

      client.data.activeDocId = dto.docId;
      client.data.projectId = dto.projectId;
      client.join(`doc:${dto.projectId}:${dto.docId}`);

      if (this.yjsDocManager) {
        this.yjsDocManager
          .getOrCreateDoc(dto.projectId, dto.docId)
          .catch(() => {});
      }

      return {
        success: true,
        docPresence: result.docPresence.map((p) => p.toJSON()),
      };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
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

      if (this.yjsDocManager) {
        const room = this.server?.sockets?.adapter?.rooms?.get(
          `doc:${dto.projectId}:${dto.docId}`,
        );
        if (!room || room.size === 0) {
          this.yjsDocManager.evictDoc(dto.projectId, dto.docId).catch(() => {});
        } else {
          this.yjsDocManager.flushDoc(dto.projectId, dto.docId).catch(() => {});
        }
      }

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  /**
   * Verifies that the client socket is authorized and joined to the target project/doc room.
   * If the socket is not yet in the room, verifies project access via `accessVerifier` and joins it.
   */
  private async ensureDocRoomAccess(
    client: Socket,
    projectId: string,
    docId: string,
    requireWrite = true,
  ): Promise<boolean> {
    const docRoom = `doc:${projectId}:${docId}`;
    const projectRoom = `project:${projectId}`;

    if (
      client.rooms?.has(docRoom) ||
      client.rooms?.has(projectRoom) ||
      (client.data?.projectId === projectId &&
        client.data?.activeDocId === docId)
    ) {
      return true;
    }

    if (this.accessVerifier) {
      const userId = client.data?.userId || '';
      const access = await this.accessVerifier.verifyProjectAccess(
        userId,
        projectId,
      );
      const allowed = requireWrite ? access.canWrite : access.canRead;
      if (!allowed) {
        return false;
      }
      client.data = client.data || {};
      client.data.projectId = projectId;
      client.data.activeDocId = docId;
      client.join?.(projectRoom);
      client.join?.(docRoom);
      return true;
    }

    return false;
  }

  @SubscribeMessage('doc:update')
  public async handleDocUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendUpdateDto,
  ) {
    try {
      const projectId = dto.projectId || client.data?.projectId;
      const docId = dto.docId || client.data?.activeDocId;
      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const authorized = await this.ensureDocRoomAccess(
        client,
        projectId,
        docId,
        true,
      );
      if (!authorized) {
        return {
          success: false,
          error: 'Socket has not joined the target document room',
        };
      }

      const userId = client.data?.userId || 'unknown';
      const result = await this.sendDocUpdateUseCase.execute({
        projectId,
        docId,
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
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  @SubscribeMessage('doc:cursor')
  public async handleCursorUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: CursorUpdateDto,
  ) {
    try {
      const projectId = dto.projectId || client.data?.projectId;
      const docId = dto.docId || client.data?.activeDocId;
      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const presence = await this.broadcastCursorUseCase.execute({
        projectId,
        docId,
        socketId: client.id,
        cursor: dto.cursor,
      });

      return { success: true, presence: presence ? presence.toJSON() : null };
    } catch (err: unknown) {
      const message = this.getErrorMessage(err);
      this.logger.debug(`Ignored ephemeral cursor error: ${message}`);
      return { success: false, error: message };
    }
  }

  @SubscribeMessage('doc:sync')
  public async handleDocSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjsDocManager)
      return { success: false, error: 'YjsDocManager not enabled' };
    try {
      const projectId = dto.projectId || client.data?.projectId;
      const docId = dto.docId || client.data?.activeDocId;
      const data = (dto.data !== undefined ? dto.data : dto) as
        Uint8Array | Buffer | number[] | string;

      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const authorized = await this.ensureDocRoomAccess(
        client,
        projectId,
        docId,
        false,
      );
      if (!authorized) {
        return {
          success: false,
          error: 'Socket has not joined the target document room',
        };
      }

      const res = await this.yjsDocManager.handleSyncMessage(
        projectId,
        docId,
        data,
        client.id,
      );

      if (res.broadcastUpdate) {
        client.to(`doc:${projectId}:${docId}`).emit('doc:sync-update', {
          projectId,
          docId,
          data: res.broadcastUpdate,
        });
      }

      return {
        success: true,
        data: res.reply || undefined,
      };
    } catch (err: unknown) {
      const message = this.getErrorMessage(err);
      this.logger.warn(`doc:sync error: ${message}`);
      return { success: false, error: message };
    }
  }

  @SubscribeMessage('doc:sync-step-1')
  public async handleSyncStep1(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjsDocManager)
      return { success: false, error: 'YjsDocManager not enabled' };
    try {
      const projectId = dto.projectId || client.data?.projectId;
      const docId = dto.docId || client.data?.activeDocId;
      const data = (dto.data !== undefined ? dto.data : dto) as
        Uint8Array | Buffer | number[] | string;

      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const authorized = await this.ensureDocRoomAccess(
        client,
        projectId,
        docId,
        false,
      );
      if (!authorized) {
        return {
          success: false,
          error: 'Socket has not joined the target document room',
        };
      }

      const reply = await this.yjsDocManager.handleSyncStep1(
        projectId,
        docId,
        data,
      );
      return { success: true, data: reply };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  @SubscribeMessage('doc:sync-step-2')
  public async handleSyncStep2(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjsDocManager)
      return { success: false, error: 'YjsDocManager not enabled' };
    try {
      const projectId = dto.projectId || client.data?.projectId;
      const docId = dto.docId || client.data?.activeDocId;
      const data = (dto.data !== undefined ? dto.data : dto) as
        Uint8Array | Buffer | number[] | string;

      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const authorized = await this.ensureDocRoomAccess(
        client,
        projectId,
        docId,
        true,
      );
      if (!authorized) {
        return {
          success: false,
          error: 'Socket has not joined the target document room',
        };
      }

      await this.yjsDocManager.handleSyncStep2(
        projectId,
        docId,
        data,
        client.id,
      );
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  @SubscribeMessage('doc:sync-update')
  public async handleSyncUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DocSyncDto,
  ) {
    if (!this.yjsDocManager)
      return { success: false, error: 'YjsDocManager not enabled' };
    try {
      const projectId = dto.projectId || client.data?.projectId;
      const docId = dto.docId || client.data?.activeDocId;
      const data = (dto.data !== undefined ? dto.data : dto) as
        Uint8Array | Buffer | number[] | string;

      if (!projectId || !docId) {
        return { success: false, error: 'Missing projectId or docId' };
      }

      const authorized = await this.ensureDocRoomAccess(
        client,
        projectId,
        docId,
        true,
      );
      if (!authorized) {
        return {
          success: false,
          error: 'Socket has not joined the target document room',
        };
      }

      const broadcastBuf = await this.yjsDocManager.handleSyncUpdate(
        projectId,
        docId,
        data,
        client.id,
      );

      client.to(`doc:${projectId}:${docId}`).emit('doc:sync-update', {
        projectId,
        docId,
        data: broadcastBuf,
      });

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  @SubscribeMessage('project:chat:send')
  public async handleSendChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: ProjectChatSendDto,
  ) {
    try {
      const projectId = dto.projectId || client.data?.projectId;
      if (!projectId || !dto.text?.trim()) {
        return { success: false, error: 'Missing projectId or empty text' };
      }

      const msg: ProjectChatMessage = {
        id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        projectId,
        userId: client.data?.userId || 'unknown',
        userName: client.data?.name || 'Collaborator',
        userColor: client.data?.color,
        userAvatar: client.data?.avatar,
        text: dto.text.trim(),
        replyToId: dto.replyToId,
        createdAt: new Date().toISOString(),
      };

      const history = this.projectChatStore.get(projectId) || [];
      history.push(msg);
      if (history.length > ManuscriptRealtimeGateway.MAX_CHAT_HISTORY) {
        history.shift();
      }
      this.projectChatStore.set(projectId, history);

      if (this.isRedisReady()) {
        try {
          const redisClient = this.redisCache!.getClient()!;
          const chatKey = `manuscript:chat:${projectId}`;
          await redisClient.rpush(chatKey, JSON.stringify(msg));
          await redisClient.ltrim(
            chatKey,
            -ManuscriptRealtimeGateway.MAX_CHAT_HISTORY,
            -1,
          );
        } catch (err) {
          this.logger.warn(
            `Redis chat persistence failed for project ${projectId}: ${err}`,
          );
        }
      }

      this.broadcasterAdapter.broadcastToProject(
        projectId,
        'project:chat:message',
        msg,
      );

      return { success: true, message: msg };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
    }
  }

  @SubscribeMessage('project:chat:history')
  public async handleGetChatHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: ProjectChatHistoryDto,
  ) {
    try {
      const projectId = dto.projectId || client.data?.projectId;
      if (!projectId) {
        return { success: false, error: 'Missing projectId' };
      }

      if (this.isRedisReady()) {
        try {
          const redisClient = this.redisCache!.getClient()!;
          const chatKey = `manuscript:chat:${projectId}`;
          const rawMessages = await redisClient.lrange(
            chatKey,
            -ManuscriptRealtimeGateway.MAX_CHAT_HISTORY,
            -1,
          );
          if (rawMessages && rawMessages.length > 0) {
            const parsed: ProjectChatMessage[] = [];
            for (const raw of rawMessages) {
              try {
                parsed.push(JSON.parse(raw) as ProjectChatMessage);
              } catch {
                // skip malformed entry
              }
            }
            this.projectChatStore.set(projectId, parsed);
            return { success: true, messages: parsed };
          }
        } catch (err) {
          this.logger.warn(
            `Redis chat history fetch failed for project ${projectId}: ${err}`,
          );
        }
      }

      const messages = this.projectChatStore.get(projectId) || [];
      return { success: true, messages };
    } catch (err: unknown) {
      return { success: false, error: this.getErrorMessage(err) };
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
