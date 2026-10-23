import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthService } from '@/modules/realtime/core/ws-auth.guard';
import { createWsConnectionMiddleware } from '@/modules/realtime/core/ws-connection.middleware';
import { REALTIME_NAMESPACES } from '@/modules/realtime/core/realtime.constant';
import { isOriginAllowed } from '@/core/http/setup/allowed-origins';
import { ChatService } from '../services/chat.service';
import { SendMessageDto } from '../dto/send-message.dto';

@Injectable()
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
  namespace: REALTIME_NAMESPACES.CHAT,
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly authService: WsAuthService,
    private readonly chatService: ChatService,
  ) {}

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
    this.logger.log('Chat WebSocket Gateway initialized on /chat');
  }

  public async handleConnection(client: Socket): Promise<void> {
    try {
      if (!client.data?.authenticated) {
        const session = await this.authService.authenticateSocket(client);
        client.data = session;
      }

      const userId = client.data.userId;
      if (userId) {
        const userRoom = `user:${userId}`;
        await client.join(userRoom);
        this.logger.debug(`Chat socket ${client.id} joined ${userRoom}`);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Unauthorized chat socket connection on ${client.id}: ${(err as Error)?.message}`,
      );
      client.disconnect(true);
    }
  }

  public handleDisconnect(client: Socket): void {
    const userId = client.data?.userId;
    if (userId) {
      client.leave(`user:${userId}`);
    }
  }

  /**
   * Client joins a conversation room to stream messages & typing status in real-time.
   */
  @SubscribeMessage('conversation:join')
  public async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId || !payload?.conversationId) return;

    try {
      await this.chatService.verifyConversationMember(
        payload.conversationId,
        userId,
      );
      const room = `conv:${payload.conversationId}`;
      await client.join(room);
      this.logger.debug(`User ${userId} joined room ${room}`);
      return { success: true };
    } catch {
      return { success: false, error: 'Unauthorized' };
    }
  }

  /**
   * Client leaves conversation room.
   */
  @SubscribeMessage('conversation:leave')
  public async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    if (!payload?.conversationId) return;
    const room = `conv:${payload.conversationId}`;
    await client.leave(room);
    return { success: true };
  }

  /**
   * Realtime message sending:
   * 1. Saves to DB and Redis RAM through ChatService.
   * 2. Broadcasts 'message:new' to active conversation room.
   * 3. Sends notification signal to all conversation participants.
   */
  @SubscribeMessage('message:send')
  public async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string; dto: SendMessageDto },
  ) {
    const userId = client.data?.userId;
    if (!userId || !payload?.conversationId || !payload?.dto) {
      return { success: false, error: 'Invalid payload' };
    }

    try {
      const message = await this.chatService.sendMessage(
        payload.conversationId,
        userId,
        payload.dto,
      );

      // Broadcast message to everyone currently in the room
      const room = `conv:${payload.conversationId}`;
      this.server.to(room).emit('message:new', message);

      return { success: true, message };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Typing indicator started.
   */
  @SubscribeMessage('typing:start')
  public async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string; userName?: string },
  ) {
    const userId = client.data?.userId;
    if (!userId || !payload?.conversationId) return;

    const room = `conv:${payload.conversationId}`;
    client.to(room).emit('typing:status', {
      conversationId: payload.conversationId,
      userId,
      userName: payload.userName || 'Someone',
      isTyping: true,
    });
  }

  /**
   * Typing indicator stopped.
   */
  @SubscribeMessage('typing:stop')
  public async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId || !payload?.conversationId) return;

    const room = `conv:${payload.conversationId}`;
    client.to(room).emit('typing:status', {
      conversationId: payload.conversationId,
      userId,
      isTyping: false,
    });
  }

  /**
   * Read receipts.
   */
  @SubscribeMessage('join_conversation')
  public async handleJoinConversationSnake(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    return this.handleJoinConversation(client, payload);
  }

  @SubscribeMessage('leave_conversation')
  public async handleLeaveConversationSnake(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    return this.handleLeaveConversation(client, payload);
  }

  @SubscribeMessage('send_message')
  public async handleSendMessageSnake(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string; dto: SendMessageDto },
  ) {
    return this.handleSendMessage(client, payload);
  }

  /**
   * Read receipts.
   */
  @SubscribeMessage('message:read')
  public async handleMessageRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId || !payload?.conversationId) return;

    await this.chatService.markAsRead(payload.conversationId, userId);

    const room = `conv:${payload.conversationId}`;
    client.to(room).emit('message:read', {
      conversationId: payload.conversationId,
      userId,
      readAt: new Date().toISOString(),
    });
  }

  @SubscribeMessage('message_read')
  public async handleMessageReadSnake(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    return this.handleMessageRead(client, payload);
  }

  @SubscribeMessage('message_reaction')
  public async handleReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      messageId: string;
      emoji: string;
      action?: 'add' | 'remove';
    },
  ) {
    const userId = client.data?.userId;
    if (!userId || !payload?.messageId || !payload?.emoji) return;

    try {
      if (payload.action === 'remove') {
        const res = await this.chatService.removeReaction(
          payload.messageId,
          userId,
          payload.emoji,
        );
        this.server.to(`conv:${res.conversationId}`).emit('reaction_updated', {
          messageId: payload.messageId,
          userId,
          emoji: payload.emoji,
          action: 'remove',
        });
      } else {
        const res = await this.chatService.addReaction(
          payload.messageId,
          userId,
          payload.emoji,
        );
        this.server.to(`conv:${res.conversationId}`).emit('reaction_updated', {
          messageId: payload.messageId,
          userId,
          emoji: payload.emoji,
          action: 'add',
        });
      }
    } catch (err: unknown) {
      client.emit('error', { message: (err as Error)?.message });
    }
  }

  /**
   * Broadcast message to room and emit updates to conversation lists.
   */
  public broadcastMessage(conversationId: string, message: unknown): void {
    if (this.server) {
      const room = `conv:${conversationId}`;
      this.server.to(room).emit('new_message', message);
      this.server.to(room).emit('message:new', message);
      this.server.emit('conversation_updated', {
        conversationId,
        message,
      });
    }
  }
}
