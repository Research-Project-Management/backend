import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REALTIME_CORE_DEFAULTS,
  RealtimeConfigService,
  parsePositiveInt,
  type RateLimitBudget,
} from '../../core/config';
import type { WsRateLimitPolicy } from '../../core/rate-limit';
import { formatProjectRoom } from '../../core/rooms';

export const WORK_ITEMS_EVENTS = {
  // Inbound (Client -> Server)
  JOIN: 'work-items:join',
  LEAVE: 'work-items:leave',

  // Outbound (Server -> Client)
  CREATED: 'work-item:created',
  UPDATED: 'work-item:updated',
  DELETED: 'work-item:deleted',
  STATE_CHANGED: 'work-item:state_changed',
  STATE_UPDATED: 'state:updated',
  ACCESS_REVOKED: 'work-items:access_revoked',
  ERROR: 'error',
} as const;

export const WORK_ITEMS_ROOMS = {
  project: formatProjectRoom,
} as const;

export type WorkItemsRateBucket = 'joinLeave';

export const WORK_ITEMS_RATE_CLASS_MAP: Readonly<
  Record<string, WorkItemsRateBucket>
> = Object.freeze({
  [WORK_ITEMS_EVENTS.JOIN]: 'joinLeave',
  [WORK_ITEMS_EVENTS.LEAVE]: 'joinLeave',
});

export function classifyWorkItemsEvent(
  eventName: string,
): WorkItemsRateBucket | null {
  return WORK_ITEMS_RATE_CLASS_MAP[eventName] ?? null;
}

export type WorkItemsRateLimitBudgets = Record<
  WorkItemsRateBucket,
  RateLimitBudget
>;

export const WORK_ITEMS_REALTIME_DEFAULTS = {
  rateLimits: {
    joinLeave: { budgetPerSec: 5, burst: 10 },
  },
} as const;

@Injectable()
export class WorkItemsRealtimeConfigService {
  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly coreConfig?: RealtimeConfigService,
  ) {}

  public getRateLimitBudgets(): WorkItemsRateLimitBudgets {
    return {
      joinLeave: {
        budgetPerSec: parsePositiveInt(
          this.config?.get<string | number>(
            'WORK_ITEMS_RATE_JOIN_LEAVE_BUDGET',
          ),
          WORK_ITEMS_REALTIME_DEFAULTS.rateLimits.joinLeave.budgetPerSec,
        ),
        burst: parsePositiveInt(
          this.config?.get<string | number>('WORK_ITEMS_RATE_JOIN_LEAVE_BURST'),
          WORK_ITEMS_REALTIME_DEFAULTS.rateLimits.joinLeave.burst,
        ),
      },
    };
  }

  public getRateLimitPolicy(): WsRateLimitPolicy {
    return {
      classify: classifyWorkItemsEvent,
      budgets: this.getRateLimitBudgets(),
      maxThrottledConsecutiveWindows:
        this.coreConfig?.getRateLimiterConfig()
          ?.maxThrottledConsecutiveWindows ??
        REALTIME_CORE_DEFAULTS.rateLimiter.maxThrottledConsecutiveWindows,
    };
  }
}
