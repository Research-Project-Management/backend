import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseFilters, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollaborationService, PresenceUser } from './collaboration.service';
import { CursorPositionDto } from './dto/collaboration.dto';

interface JoinDocumentPayload {
  pageId: string;
  projectId?: string;
  user: {
    id: string;
    name: string;
    avatar?: string;
    role?: string;
  };
}

interface CursorMovePayload {
  pageId: string;
  cursor: CursorPositionDto;
}

interface DocumentChangePayload {
  pageId: string;
  delta: unknown;
  version?: number;
}

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/collaboration',
})
export class CollaborationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(CollaborationGateway.name);
  private readonly socketToUser = new Map<
    string,
    { pageId: string; userId: string }
  >();

  constructor(
    private readonly collaborationService: CollaborationService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  handleConnection(client: Socket) {
    this.logger.debug(`[WebSocket] Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    const meta = this.socketToUser.get(client.id);
    if (meta) {
      const { pageId, userId } = meta;
      this.socketToUser.delete(client.id);

      const remainingUsers = await this.collaborationService.leaveRoom(
        pageId,
        userId,
      );
      this.server.to(`doc:${pageId}`).emit('user_left', {
        userId,
        activeUsers: remainingUsers,
        timestamp: Date.now(),
      });
      this.logger.debug(
        `[WebSocket] Client ${client.id} (user: ${userId}) disconnected from doc:${pageId}`,
      );
    }
  }

  @SubscribeMessage('join_document')
  async handleJoinDocument(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinDocumentPayload,
  ) {
    if (!payload?.pageId || !payload?.user?.id) {
      return { status: 'error', message: 'Missing pageId or user info' };
    }

    const { pageId, user } = payload;
    const room = `doc:${pageId}`;

    await client.join(room);
    this.socketToUser.set(client.id, { pageId, userId: user.id });

    const activeUsers = await this.collaborationService.updatePresence(pageId, {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      role: user.role || 'viewer',
    });

    // Notify room of joined user
    client.to(room).emit('user_joined', {
      user: activeUsers.find((u) => u.id === user.id),
      activeUsers,
      timestamp: Date.now(),
    });

    // Return current active users to the joining client
    return {
      status: 'ok',
      activeUsers,
    };
  }

  @SubscribeMessage('leave_document')
  async handleLeaveDocument(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; userId: string },
  ) {
    if (!payload?.pageId || !payload?.userId) return;

    const { pageId, userId } = payload;
    const room = `doc:${pageId}`;

    await client.leave(room);
    this.socketToUser.delete(client.id);

    const activeUsers = await this.collaborationService.leaveRoom(pageId, userId);
    this.server.to(room).emit('user_left', {
      userId,
      activeUsers,
      timestamp: Date.now(),
    });

    return { status: 'ok' };
  }

  @SubscribeMessage('cursor_move')
  async handleCursorMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CursorMovePayload,
  ) {
    const meta = this.socketToUser.get(client.id);
    if (!meta || meta.pageId !== payload.pageId) return;

    const room = `doc:${payload.pageId}`;
    client.to(room).emit('cursor_updated', {
      userId: meta.userId,
      cursor: payload.cursor,
      timestamp: Date.now(),
    });
  }

  @SubscribeMessage('document_change')
  async handleDocumentChange(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: DocumentChangePayload,
  ) {
    const meta = this.socketToUser.get(client.id);
    if (!meta || meta.pageId !== payload.pageId) return;

    const room = `doc:${payload.pageId}`;
    // Broadcast high-frequency delta to other collaborators in the room
    client.to(room).emit('document_updated', {
      userId: meta.userId,
      delta: payload.delta,
      version: payload.version,
      timestamp: Date.now(),
    });
  }

  @SubscribeMessage('lock_state')
  async handleLockState(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { pageId: string; isLocked: boolean; lockedBy: string },
  ) {
    const room = `doc:${payload.pageId}`;
    this.collaborationService.broadcastLockChange(
      payload.pageId,
      payload.isLocked,
      payload.lockedBy,
    );
    this.server.to(room).emit('lock_updated', {
      isLocked: payload.isLocked,
      lockedBy: payload.lockedBy,
      timestamp: Date.now(),
    });
  }
}
