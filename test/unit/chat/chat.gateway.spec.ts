import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

describe('ChatGateway Unit & Extraction Boundary Tests', () => {
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

  it('attaches WsAllExceptionsFilter and ValidationPipe metadata and registers auth middleware on afterInit', () => {
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      ChatGateway,
    ) as unknown[];
    const pipes = Reflect.getMetadata(PIPES_METADATA, ChatGateway) as unknown[];
    expect(filters).toContain(WsAllExceptionsFilter);
    expect(Array.isArray(pipes) && pipes.length > 0).toBe(true);

    gateway.afterInit(mockServer);
    expect(mockServer.use).toHaveBeenCalledWith(expect.any(Function));
  });

  it('joins user room on connection and cleans up rateLimiter + user room on disconnect', async () => {
    const { socket, join, leave } = makeSocket({ userId: 'user-42' });

    await gateway.handleConnection(socket);
    expect(join).toHaveBeenCalledWith(CHAT_ROOMS.user('user-42'));

    const cleanupSpy = jest.spyOn(rateLimiter, 'cleanupSocket');
    gateway.handleDisconnect(socket);
    expect(cleanupSpy).toHaveBeenCalledWith(socket.id);
    expect(leave).toHaveBeenCalledWith(CHAT_ROOMS.user('user-42'));
  });

  it('disconnects unauthorized socket on handleConnection failure', async () => {
    const { socket } = makeSocket({ authenticated: false });
    mockAuthService.authenticateSocket.mockRejectedValue(
      new RealtimeAuthRequiredException(),
    );

    await gateway.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('verifies membership on conversation:join and denies non-members without joining', async () => {
    const memberCtx = makeSocket({ userId: 'user-1' });
    await expect(
      gateway.handleJoinConversation(memberCtx.socket, {
        conversationId: 'conv-1',
      }),
    ).resolves.toEqual({ success: true });
    expect(memberCtx.join).toHaveBeenCalledWith(
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
  });

  it('leaves conversation room on conversation:leave', async () => {
    const { socket, leave } = makeSocket({
      userId: 'user-1',
      rooms: [CHAT_ROOMS.conversation('conv-1')],
    });

    await expect(
      gateway.handleLeaveConversation(socket, { conversationId: 'conv-1' }),
    ).resolves.toEqual({ success: true });
    expect(leave).toHaveBeenCalledWith(CHAT_ROOMS.conversation('conv-1'));
  });

  it('delivers chat:message via RealtimeEventBus ONLY to conv room and user:<memberId> rooms', async () => {
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
    expect(serverTo).toHaveBeenCalledWith(CHAT_ROOMS.conversation('conv-1'));
    expect(
      roomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenCalledWith(CHAT_EVENTS.MESSAGE_NEW, savedMsg);
    expect(serverTo).toHaveBeenCalledWith(['user:user-1', 'user:user-2']);
    expect(roomEmitMap.get('user:user-1,user:user-2')).toHaveBeenCalledWith(
      CHAT_EVENTS.CONVERSATION_UPDATED,
      { conversationId: 'conv-1', message: savedMsg },
    );
    expect(serverEmit).not.toHaveBeenCalled();

    // Also verifies external publish through RealtimeEventBus (REST -> Realtime service path)
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
    expect(roomEmitMap.get('user:user-2')).toHaveBeenCalledWith(
      CHAT_EVENTS.CONVERSATION_UPDATED,
      { conversationId: 'conv-1', message: { id: 'msg-rest' } },
    );
  });

  it('skips user-room broadcast cleanly when member list is empty', async () => {
    mockChatPort.getConversationMemberIds.mockResolvedValue([]);
    await gateway.broadcastMessage('conv-empty', { id: 'msg-x' });

    expect(serverTo).toHaveBeenCalledTimes(1);
    expect(serverTo).toHaveBeenCalledWith(
      CHAT_ROOMS.conversation('conv-empty'),
    );
    expect(serverEmit).not.toHaveBeenCalled();
  });

  it('enforces membership on typing:start/stop and avoids DB calls when socket is already in conv room', async () => {
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
  });

  it('enforces membership on message:read and emits canonical message:read event', async () => {
    const { socket, clientRoomEmitMap } = makeSocket({ userId: 'user-1' });
    const res = await gateway.handleMessageRead(socket, {
      conversationId: 'conv-1',
    });

    expect(mockChatPort.markAsRead).toHaveBeenCalledWith('conv-1', 'user-1');
    expect(
      clientRoomEmitMap.get(CHAT_ROOMS.conversation('conv-1')),
    ).toHaveBeenCalledWith(CHAT_EVENTS.MESSAGE_READ, {
      conversationId: 'conv-1',
      userId: 'user-1',
      readAt: '2026-11-20T12:00:00.000Z',
    });
    expect(res).toEqual({
      success: true,
      readAt: '2026-11-20T12:00:00.000Z',
    });
  });

  it('emits canonical message:reaction_updated WITH conversationId for add and remove via bus', async () => {
    const { socket } = makeSocket({ userId: 'user-1' });
    mockChatPort.addReaction.mockResolvedValue({
      conversationId: 'conv-1',
      reaction: { id: 'r1' },
    });
    mockChatPort.removeReaction.mockResolvedValue({
      conversationId: 'conv-1',
      success: true,
    });

    await gateway.handleReaction(socket, {
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

    await gateway.handleReaction(socket, {
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

  it('enforces chat rate limits on message bursts', async () => {
    const { socket } = makeSocket({ userId: 'user-burst' });
    const burst = chatConfig.getRateLimitBudgets().joinLeave.burst;

    for (let i = 0; i < burst; i += 1) {
      await gateway.handleLeaveConversation(socket, {
        conversationId: 'conv-1',
      });
    }

    await expect(
      gateway.handleLeaveConversation(socket, { conversationId: 'conv-1' }),
    ).rejects.toThrow(RealtimeRateLimitedException);
  });

  it('keeps realtime/channels/chat decoupled from @/modules/chat and removes legacy gateways & snake_case events', () => {
    expect(
      fs.existsSync(
        path.resolve(__dirname, '../../../src/modules/chat/gateways'),
      ),
    ).toBe(false);

    const chatChannelDir = path.resolve(
      __dirname,
      '../../../src/modules/realtime/channels/chat',
    );
    const gatewayContent = fs.readFileSync(
      path.join(chatChannelDir, 'gateway.ts'),
      'utf8',
    );
    const configContent = fs.readFileSync(
      path.join(chatChannelDir, 'config.ts'),
      'utf8',
    );

    expect(gatewayContent).not.toMatch(/this\.server\.emit\s*\(/);
    for (const content of [gatewayContent, configContent]) {
      expect(content).not.toMatch(/@\/modules\/chat/);
      for (const legacyEvent of [
        'join_conversation',
        'leave_conversation',
        'send_message',
        'message_read',
        'message_reaction',
        'new_message',
        'reaction_updated',
        'conversation_updated',
      ]) {
        expect(content).not.toMatch(new RegExp(`['"]${legacyEvent}['"]`));
      }
    }
  });
});
