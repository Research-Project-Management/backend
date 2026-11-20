import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REALTIME_CORE_DEFAULTS,
  RealtimeConfigService,
  parsePositiveInt,
  type RateLimitBudget,
} from '../../core/config';
import type { WsRateLimitPolicy } from '../../core/rate-limit';
import { formatConversationRoom, formatUserRoom } from '../../core/rooms';

export const CHAT_EVENTS = {
  CONVERSATION_JOIN: 'conversation:join',
  CONVERSATION_LEAVE: 'conversation:leave',
  CONVERSATION_UPDATED: 'conversation:updated',
  MESSAGE_SEND: 'message:send',
  MESSAGE_NEW: 'message:new',
  MESSAGE_READ: 'message:read',
  MESSAGE_REACTION: 'message:reaction',
  REACTION_UPDATED: 'message:reaction_updated',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  TYPING_STATUS: 'typing:status',
  ERROR: 'error',
} as const;

export const CHAT_ROOMS = {
  user: formatUserRoom,
  conversation: formatConversationRoom,
} as const;

export type ChatRateBucket = 'message' | 'joinLeave' | 'typing';

export const CHAT_RATE_CLASS_MAP: Readonly<Record<string, ChatRateBucket>> =
  Object.freeze({
    [CHAT_EVENTS.MESSAGE_SEND]: 'message',
    [CHAT_EVENTS.MESSAGE_READ]: 'message',
    [CHAT_EVENTS.MESSAGE_REACTION]: 'message',
    [CHAT_EVENTS.CONVERSATION_JOIN]: 'joinLeave',
    [CHAT_EVENTS.CONVERSATION_LEAVE]: 'joinLeave',
    [CHAT_EVENTS.TYPING_START]: 'typing',
    [CHAT_EVENTS.TYPING_STOP]: 'typing',
  });

export function classifyChatEvent(eventName: string): ChatRateBucket | null {
  return CHAT_RATE_CLASS_MAP[eventName] ?? null;
}

export type ChatRateLimitBudgets = Record<ChatRateBucket, RateLimitBudget>;

export const CHAT_REALTIME_DEFAULTS = {
  rateLimits: {
    message: { budgetPerSec: 5, burst: 10 },
    joinLeave: { budgetPerSec: 5, burst: 10 },
    typing: { budgetPerSec: 10, burst: 20 },
  },
} as const;

@Injectable()
export class ChatRealtimeConfigService {
  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly coreConfig?: RealtimeConfigService,
  ) {}

  public getRateLimitBudgets(): ChatRateLimitBudgets {
    return {
      message: {
        budgetPerSec: parsePositiveInt(
          this.config?.get<string | number>('REALTIME_RATE_CHAT_BUDGET'),
          CHAT_REALTIME_DEFAULTS.rateLimits.message.budgetPerSec,
        ),
        burst: parsePositiveInt(
          this.config?.get<string | number>('REALTIME_RATE_CHAT_BURST'),
          CHAT_REALTIME_DEFAULTS.rateLimits.message.burst,
        ),
      },
      joinLeave: {
        budgetPerSec: parsePositiveInt(
          this.config?.get<string | number>('CHAT_RATE_JOIN_LEAVE_BUDGET'),
          CHAT_REALTIME_DEFAULTS.rateLimits.joinLeave.budgetPerSec,
        ),
        burst: parsePositiveInt(
          this.config?.get<string | number>('CHAT_RATE_JOIN_LEAVE_BURST'),
          CHAT_REALTIME_DEFAULTS.rateLimits.joinLeave.burst,
        ),
      },
      typing: {
        budgetPerSec: parsePositiveInt(
          this.config?.get<string | number>('CHAT_RATE_TYPING_BUDGET'),
          CHAT_REALTIME_DEFAULTS.rateLimits.typing.budgetPerSec,
        ),
        burst: parsePositiveInt(
          this.config?.get<string | number>('CHAT_RATE_TYPING_BURST'),
          CHAT_REALTIME_DEFAULTS.rateLimits.typing.burst,
        ),
      },
    };
  }

  public getRateLimitPolicy(): WsRateLimitPolicy {
    return {
      classify: classifyChatEvent,
      budgets: this.getRateLimitBudgets(),
      maxThrottledConsecutiveWindows:
        this.coreConfig?.getRateLimiterConfig()
          ?.maxThrottledConsecutiveWindows ??
        REALTIME_CORE_DEFAULTS.rateLimiter.maxThrottledConsecutiveWindows,
    };
  }
}
