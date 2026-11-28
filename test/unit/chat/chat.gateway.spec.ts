import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Server, Socket } from 'socket.io';
import {
  CHAT_EVENTS,
  CHAT_ROOMS,
  ChatRealtimeConfigService,
} from '@/modules/realtime/channels/chat/config';
import { ChatGateway } from '@/modules/realtime/channels/chat/gateway';
import type { ChatRealtimePort } from '@/modules/realtime/ports/chat';
import { RealtimeEventBus } from '@/modules/realtime/core/bus';
import {
  RealtimeAccessDeniedException,
  RealtimeAuthRequiredException,
  RealtimeRateLimitedException,
  WsAllExceptionsFilter,
  WsRateLimiter,
  type WsAuthService,
} from '@/modules/realtime';

describe('ChatGateway Unit Tests', () => {
  let gateway: ChatGateway;
  let mockAuthService: jest.Mocked<WsAuthService>;
  let mockChatPort: {
    verifyConversationMember: jest.Mock;
    sendMessage: jest.Mock;
    markAsRead: jest.Mock;
    addReaction: jest.Mock;
    removeReaction: jest.Mock;
    getConversationMemberIds: jest.Mock;
  };
  let rateLimiter: WsRateLimiter;
  let chatConfig: ChatRealtimeConfigService;
  let realtimeBus: RealtimeEventBus;
  let serverEmit: jest.Mock;
  let roomEmitMap: Map<string, jest.Mock>;
  let serverTo: jest.Mock;
  let mockServer: Server;

  const makeSocket = (overrides?: {
    id?: string;
    authenticated?: boolean;
    userId?: string;
    name?: string;
    rooms?: string[];
  }) => {
    const rooms = new Set<string>(overrides?.rooms ?? []);
    const join = jest.fn(async (room: string) => {
      rooms.add(room);
    });
    const leave = jest.fn(async (room: string) => {
      rooms.delete(room);
    });
    const clientRoomEmitMap = new Map<string, jest.Mock>();
    const clientTo = jest.fn((target: string) => {
      let fn = clientRoomEmitMap.get(target);
      if (!fn) {
        fn = jest.fn();
        clientRoomEmitMap.set(target, fn);
      }
      return { emit: fn };
    });

    const socket = fromPartial<Socket>({
      id: overrides?.id ?? 'sock-chat-1',
      data:
        overrides?.authenticated === false
          ? { authenticated: false }
          : {
              authenticated: overrides?.authenticated ?? true,
              userId: overrides?.userId ?? 'user-1',
              name: overrides?.name ?? 'Alice',
            },
      rooms,
      join,
      leave,
      disconnect: jest.fn(),
      to: clientTo as never,
    });

    return { socket, join, leave, clientTo, clientRoomEmitMap, rooms };
  };

  beforeEach(() => {
    mockAuthService = fromPartial<jest.Mocked<WsAuthService>>({
      authenticateSocket: jest.fn(),
    });

    mockChatPort = {
      verifyConversationMember: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      sendMessage: jest.fn(),
      markAsRead: jest.fn().mockResolvedValue({
        success: true,
        lastReadAt: '2026-11-20T12:00:00.000Z',
      }),
      addReaction: jest.fn(),
      removeReaction: jest.fn(),
      getConversationMemberIds: jest
        .fn()
        .mockResolvedValue(['user-1', 'user-2']),
    };

    rateLimiter = new WsRateLimiter();
    chatConfig = new ChatRealtimeConfigService();
    realtimeBus = new RealtimeEventBus();

    gateway = new ChatGateway(
      mockAuthService,
      fromPartial<ChatRealtimePort>(mockChatPort),
      rateLimiter,
      chatConfig,
      realtimeBus,
    );

    serverEmit = jest.fn();
    roomEmitMap = new Map<string, jest.Mock>();
    serverTo = jest.fn((target: string | string[]) => {
      const key = Array.isArray(target) ? target.join(',') : target;
      let fn = roomEmitMap.get(key);
      if (!fn) {
        fn = jest.fn();
        roomEmitMap.set(key, fn);
      }
      return { emit: fn };
    });

    mockServer = fromPartial<Server>({
      use: jest.fn(),
      emit: serverEmit,
      local: fromPartial<Server>({
        to: serverTo as never,
      }) as never,
      to: serverTo as never,
    });
    gateway.server = mockServer;
    gateway.onModuleInit();
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  it('attaches WsAllExceptionsFilter and ValidationPipe, manages user room lifecycle, and disconnects unauthorized sockets', async () => {
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      ChatGateway,
    ) as unknown[];
    const pipes = Reflect.getMetadata(PIPES_METADATA, ChatGateway) as unknown[];
    expect(filters).toContain(WsAllExceptionsFilter);
    expect(Array.isArray(pipes) && pipes.length > 0).toBe(true);

    gateway.afterInit(mockServer);
    expect(mockServer.use).toHaveBeenCalledWith(expect.any(Function));

    const { socket, join, leave } = makeSocket({ userId: 'user-42' });
    await gateway.handleConnection(socket);
    expect(join).toHaveBeenCalledWith(CHAT_ROOMS.user('user-42'));

    const cleanupSpy = jest.spyOn(rateLimiter, 'cleanupSocket');
    gateway.handleDisconnect(socket);
    expect(cleanupSpy).toHaveBeenCalledWith(socket.id);
    expect(leave).toHaveBeenCalledWith(CHAT_ROOMS.user('user-42'));

    const unauth = makeSocket({ authenticated: false });
    mockAuthService.authenticateSocket.mockRejectedValueOnce(
      new RealtimeAuthRequiredException(),
    );
    await gateway.handleConnection(unauth.socket);
    expect(unauth.socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('verifies membership on conversation:join, handles conversation:leave, and enforces rate limits', async () => {
    const memberCtx = makeSocket({ userId: 'user-1' });
    await expect(
      gateway.handleJoinConversation(memberCtx.socket, {
        conversationId: 'conv-1',
      }),
    ).resolves.toEqual({ success: true });
    expect(memberCtx.join).toHaveBeenCalledWith(
      CHAT_ROOMS.conversation('conv-1'),
    );

    await expect(
      gateway.handleLeaveConversation(memberCtx.socket, {
        conversationId: 'conv-1',
      }),
    ).resolves.toEqual({ success: true });
    expect(memberCtx.leave).toHaveBeenCalledWith(
      CHAT_ROOMS.conversation('conv-1'),
    );

    const outsiderCtx = makeSocket({ id: 'sock-out', userId: 'outsider' });
    mockChatPort.verifyConversationMember.mockRejectedValueOnce(
      new ForbiddenException('Not a member'),
    );
    await expect(
      gateway.handleJoinConversation(outsiderCtx.socket, {
        conversationId: 'conv-1',
      }),
    ).rejects.toThrow(RealtimeAccessDeniedException);
    expect(outsiderCtx.join).not.toHaveBeenCalled();

    mockChatPort.verifyConversationMember.mockRejectedValueOnce(
      new NotFoundException('Missing conversation'),
    );
    await expect(
      gateway.handleJoinConversation(outsiderCtx.socket, {
        conversationId: 'conv-404',
      }),
    ).rejects.toThrow(RealtimeAccessDeniedException);

    const { socket: burstSocket } = makeSocket({
      id: 'sock-burst',
      userId: 'user-burst',
    });
    const burst = chatConfig.getRateLimitBudgets().joinLeave.burst;
    for (let i = 0; i < burst; i += 1) {
      await gateway.handleLeaveConversation(burstSocket, {
        conversationId: 'conv-1',
      });
    }
    await expect(
      gateway.handleLeaveConversation(burstSocket, { conversationId: 'conv-1' }),
    ).rejects.toThrow(RealtimeRateLimitedException);
  });

  it('delivers chat:message via RealtimeEventBus strictly to conv and user:<memberId> rooms, skipping empty member lists', async () => {
    const { socket } = makeSocket({ userId: 'user-1' });
    const savedMsg = { id: 'msg-1', conversationId: 'conv-1', content: 'Hi' };
    mockChatPort.sendMessage.mockResolvedValue(savedMsg);
    mockChatPort.getConversationMemberIds.mockResolvedValue([
      'user-1',
      'user-2',
    ]);

    const res = await gateway.handleSendMessage(socket, {
      conversationId: 'conv-1',
      dto: { content: 'Hi' },
    });

    expect(res).toEqual({ success: true, message: savedMsg });
    expect(
      roomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenCalledWith(CHAT_EVENTS.MESSAGE_NEW, savedMsg);
    expect(roomEmitMap.get('user:user-1,user:user-2')).toHaveBeenCalledWith(
      CHAT_EVENTS.CONVERSATION_UPDATED,
      { conversationId: 'conv-1', message: savedMsg },
    );
    expect(serverEmit).not.toHaveBeenCalled();

    roomEmitMap.clear();
    serverTo.mockClear();
    await realtimeBus.publish({
      type: 'chat:message',
      conversationId: 'conv-1',
      message: { id: 'msg-rest' },
      memberIds: ['user-2'],
    });
    expect(
      roomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenCalledWith(CHAT_EVENTS.MESSAGE_NEW, { id: 'msg-rest' });

    serverTo.mockClear();
    mockChatPort.getConversationMemberIds.mockResolvedValueOnce([]);
    await gateway.broadcastMessage('conv-empty', { id: 'msg-x' });
    expect(serverTo).toHaveBeenCalledTimes(1);
    expect(serverTo).toHaveBeenCalledWith(
      CHAT_ROOMS.conversation('conv-empty'),
    );
  });

  it('handles typing:start/stop, message:read, and message:reaction_updated with membership verification', async () => {
    const joinedCtx = makeSocket({
      userId: 'user-1',
      name: 'Alice',
      rooms: [CHAT_ROOMS.conversation('conv-1')],
    });
    await gateway.handleTypingStart(joinedCtx.socket, {
      conversationId: 'conv-1',
      userName: 'Alice',
    });
    expect(mockChatPort.verifyConversationMember).not.toHaveBeenCalled();
    expect(
      joinedCtx.clientRoomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenCalledWith(CHAT_EVENTS.TYPING_STATUS, {
      conversationId: 'conv-1',
      userId: 'user-1',
      userName: 'Alice',
      isTyping: true,
    });

    await gateway.handleTypingStop(joinedCtx.socket, {
      conversationId: 'conv-1',
      userName: 'Alice',
    });
    expect(
      joinedCtx.clientRoomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenLastCalledWith(CHAT_EVENTS.TYPING_STATUS, {
      conversationId: 'conv-1',
      userId: 'user-1',
      userName: 'Alice',
      isTyping: false,
    });

    const outsiderCtx = makeSocket({ id: 'sock-out-2', userId: 'outsider' });
    mockChatPort.verifyConversationMember.mockRejectedValueOnce(
      new ForbiddenException('Forbidden'),
    );
    await expect(
      gateway.handleTypingStart(outsiderCtx.socket, {
        conversationId: 'conv-1',
      }),
    ).rejects.toThrow(RealtimeAccessDeniedException);

    // message:read
    const readCtx = makeSocket({ userId: 'user-1' });
    const readRes = await gateway.handleMessageRead(readCtx.socket, {
      conversationId: 'conv-1',
    });
    expect(readRes).toEqual({
      success: true,
      readAt: '2026-11-20T12:00:00.000Z',
    });

    // message:reaction_updated
    mockChatPort.addReaction.mockResolvedValue({
      conversationId: 'conv-1',
      reaction: { id: 'r1' },
    });
    mockChatPort.removeReaction.mockResolvedValue({
      conversationId: 'conv-1',
      success: true,
    });

    await gateway.handleReaction(readCtx.socket, {
      messageId: 'msg-1',
      emoji: '👍',
      action: 'add',
    });
    expect(
      roomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenCalledWith(CHAT_EVENTS.REACTION_UPDATED, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
      action: 'add',
    });

    await gateway.handleReaction(readCtx.socket, {
      messageId: 'msg-1',
      emoji: '👍',
      action: 'remove',
    });
    expect(
      roomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenLastCalledWith(CHAT_EVENTS.REACTION_UPDATED, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
      action: 'remove',
    });
  });
});
