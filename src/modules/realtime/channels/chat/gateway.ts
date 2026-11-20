import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import {
  WsAuthService,
  createWsConnectionMiddleware,
  type WsUserSession,
} from '../../core/auth';
import { REALTIME_NAMESPACES, createWsCorsOptions } from '../../core/config';
import {
  RealtimeAccessDeniedException,
  RealtimeAuthRequiredException,
  WsAllExceptionsFilter,
} from '../../core/errors';
import { WsRateLimiter } from '../../core/rate-limit';
import { emitToLocalRoom, isSocketInRoom } from '../../core/rooms';
import { CHAT_REALTIME_PORT, type ChatRealtimePort } from '../../ports/chat';
import {
  RealtimeEventBus,
  type ChatReactionBroadcastPayload,
} from '../../core/bus';
import { CHAT_EVENTS, CHAT_ROOMS, ChatRealtimeConfigService } from './config';
import {
  ConversationRoomWsDto,
  MessageReactionWsDto,
  MessageReadWsDto,
  SendMessageWsDto,
  TypingStartWsDto,
  TypingStopWsDto,
} from './dto';

export type BroadcastReactionPayload = ChatReactionBroadcastPayload;

@Injectable()
@UseFilters(WsAllExceptionsFilter)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
@WebSocketGateway({
  cors: createWsCorsOptions(),
  namespace: REALTIME_NAMESPACES.CHAT,
})
export class ChatGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);
  private unsubscribeBus?: () => void;

  constructor(
    private readonly authService: WsAuthService,
    @Inject(CHAT_REALTIME_PORT) private readonly chatPort: ChatRealtimePort,
    private readonly rateLimiter: WsRateLimiter,
    private readonly chatRealtimeConfig: ChatRealtimeConfigService,
    @Optional() private readonly realtimeBus?: RealtimeEventBus,
  ) {}

  public onModuleInit(): void {
    if (!this.realtimeBus) {
      return;
    }

    this.unsubscribeBus = this.realtimeBus.subscribe(async (envelope) => {
      if (envelope.type === 'chat:message') {
        await this.deliverMessageLocally(
          envelope.conversationId,
          envelope.message,
          envelope.memberIds,
        );
      } else if (envelope.type === 'chat:reaction') {
        this.deliverReactionLocally(envelope.conversationId, envelope.payload);
      }
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
  }

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
    this.logger.log('Chat WebSocket Gateway initialized on /chat');
  }

  public async handleConnection(client: Socket): Promise<void> {
    try {
      const existingData = client.data as Partial<WsUserSession> | undefined;
      if (!existingData?.authenticated) {
        const session = await this.authService.authenticateSocket(client);
        client.data = {
          ...existingData,
          ...session,
        };
      }

      const { userId } = this.getAuthenticatedUser(client);
      const userRoom = CHAT_ROOMS.user(userId);
      await client.join(userRoom);
      this.logger.debug(`Chat socket ${client.id} joined ${userRoom}`);
    } catch (err: unknown) {
      this.logger.warn(
        `Unauthorized chat socket connection on ${client.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      client.disconnect(true);
    }
  }

  public handleDisconnect(client: Socket): void {
    this.rateLimiter.cleanupSocket(client.id);
    const userId = (client.data as Partial<WsUserSession> | undefined)?.userId;
    if (userId) {
      void client.leave(CHAT_ROOMS.user(userId));
    }
  }

  @SubscribeMessage(CHAT_EVENTS.CONVERSATION_JOIN)
  public async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ConversationRoomWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.CONVERSATION_JOIN);
    const { userId } = this.getAuthenticatedUser(client);

    await this.verifyMemberOrThrow(payload.conversationId, userId);

    const room = CHAT_ROOMS.conversation(payload.conversationId);
    await client.join(room);
    this.logger.debug(`User ${userId} joined room ${room}`);
    return { success: true };
  }

  @SubscribeMessage(CHAT_EVENTS.CONVERSATION_LEAVE)
  public async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ConversationRoomWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.CONVERSATION_LEAVE);
    this.getAuthenticatedUser(client);

    const room = CHAT_ROOMS.conversation(payload.conversationId);
    await client.leave(room);
    return { success: true };
  }

  @SubscribeMessage(CHAT_EVENTS.MESSAGE_SEND)
  public async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendMessageWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.MESSAGE_SEND);
    const { userId } = this.getAuthenticatedUser(client);

    const message = await this.runWithAccessMapping(() =>
      this.chatPort.sendMessage(payload.conversationId, userId, payload.dto),
    );

    await this.broadcastMessage(payload.conversationId, message);
    return { success: true, message };
  }

  @SubscribeMessage(CHAT_EVENTS.TYPING_START)
  public async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TypingStartWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.TYPING_START);
    const { userId, name } = this.getAuthenticatedUser(client);

    await this.ensureConversationAccess(client, payload.conversationId, userId);

    const room = CHAT_ROOMS.conversation(payload.conversationId);
    const userName = payload.userName?.trim() || name || 'Someone';
    client.to(room).emit(CHAT_EVENTS.TYPING_STATUS, {
      conversationId: payload.conversationId,
      userId,
      userName,
      isTyping: true,
    });
  }

  @SubscribeMessage(CHAT_EVENTS.TYPING_STOP)
  public async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TypingStopWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.TYPING_STOP);
    const { userId, name } = this.getAuthenticatedUser(client);

    await this.ensureConversationAccess(client, payload.conversationId, userId);

    const room = CHAT_ROOMS.conversation(payload.conversationId);
    const userName = payload.userName?.trim() || name || 'Someone';
    client.to(room).emit(CHAT_EVENTS.TYPING_STATUS, {
      conversationId: payload.conversationId,
      userId,
      userName,
      isTyping: false,
    });
  }

  @SubscribeMessage(CHAT_EVENTS.MESSAGE_READ)
  public async handleMessageRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: MessageReadWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.MESSAGE_READ);
    const { userId } = this.getAuthenticatedUser(client);

    const result = await this.runWithAccessMapping(() =>
      this.chatPort.markAsRead(payload.conversationId, userId),
    );

    const room = CHAT_ROOMS.conversation(payload.conversationId);
    client.to(room).emit(CHAT_EVENTS.MESSAGE_READ, {
      conversationId: payload.conversationId,
      userId,
      readAt: result.lastReadAt,
    });

    return { success: true, readAt: result.lastReadAt };
  }

  @SubscribeMessage(CHAT_EVENTS.MESSAGE_REACTION)
  public async handleReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: MessageReactionWsDto,
  ) {
    this.enforceRateLimit(client, CHAT_EVENTS.MESSAGE_REACTION);
    const { userId } = this.getAuthenticatedUser(client);

    const action: 'add' | 'remove' =
      payload.action === 'remove' ? 'remove' : 'add';

    const res = await this.runWithAccessMapping<{ conversationId: string }>(
      () =>
        action === 'remove'
          ? this.chatPort.removeReaction(
              payload.messageId,
              userId,
              payload.emoji,
            )
          : this.chatPort.addReaction(payload.messageId, userId, payload.emoji),
    );

    await this.broadcastReaction(res.conversationId, {
      conversationId: res.conversationId,
      messageId: payload.messageId,
      userId,
      emoji: payload.emoji,
      action,
    });

    return { success: true };
  }

  public async broadcastMessage(
    conversationId: string,
    message: unknown,
    memberIds?: string[],
  ): Promise<void> {
    if (this.realtimeBus) {
      await this.realtimeBus.publish({
        type: 'chat:message',
        conversationId,
        message,
        memberIds,
      });
      return;
    }

    await this.deliverMessageLocally(conversationId, message, memberIds);
  }

  public async broadcastReaction(
    conversationId: string,
    payload: BroadcastReactionPayload,
  ): Promise<void> {
    if (this.realtimeBus) {
      await this.realtimeBus.publish({
        type: 'chat:reaction',
        conversationId,
        payload,
      });
      return;
    }

    this.deliverReactionLocally(conversationId, payload);
  }

  private async deliverMessageLocally(
    conversationId: string,
    message: unknown,
    memberIds?: string[],
  ): Promise<void> {
    if (!this.server) {
      return;
    }

    const room = CHAT_ROOMS.conversation(conversationId);
    emitToLocalRoom(this.server, room, CHAT_EVENTS.MESSAGE_NEW, message);

    try {
      const resolvedMembers =
        memberIds ??
        (await this.chatPort.getConversationMemberIds(conversationId));
      const userRooms = resolvedMembers.map((memberId) =>
        CHAT_ROOMS.user(memberId),
      );
      if (userRooms.length > 0) {
        emitToLocalRoom(
          this.server,
          userRooms,
          CHAT_EVENTS.CONVERSATION_UPDATED,
          {
            conversationId,
            message,
          },
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to fan out conversation:updated for ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private deliverReactionLocally(
    conversationId: string,
    payload: BroadcastReactionPayload,
  ): void {
    if (!this.server) {
      return;
    }

    emitToLocalRoom(
      this.server,
      CHAT_ROOMS.conversation(conversationId),
      CHAT_EVENTS.REACTION_UPDATED,
      payload,
    );
  }

  private getAuthenticatedUser(client: Socket): {
    userId: string;
    name?: string;
  } {
    const data = client.data as Partial<WsUserSession> | undefined;
    if (
      !data?.authenticated ||
      typeof data.userId !== 'string' ||
      data.userId.length === 0
    ) {
      throw new RealtimeAuthRequiredException();
    }

    return {
      userId: data.userId,
      name:
        typeof data.name === 'string' && data.name.trim()
          ? data.name.trim()
          : undefined,
    };
  }

  private enforceRateLimit(client: Socket, eventName: string): void {
    this.rateLimiter.consumeOrThrow(
      client,
      eventName,
      this.chatRealtimeConfig.getRateLimitPolicy(),
    );
  }

  private async verifyMemberOrThrow(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    await this.runWithAccessMapping(() =>
      this.chatPort.verifyConversationMember(conversationId, userId),
    );
  }

  private async ensureConversationAccess(
    client: Socket,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    if (isSocketInRoom(client, CHAT_ROOMS.conversation(conversationId))) {
      return;
    }
    await this.verifyMemberOrThrow(conversationId, userId);
  }

  private async runWithAccessMapping<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      if (
        err instanceof ForbiddenException ||
        err instanceof NotFoundException
      ) {
        throw new RealtimeAccessDeniedException('Unauthorized');
      }
      throw err;
    }
  }
}
