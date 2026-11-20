import { Injectable, Logger, Optional } from '@nestjs/common';
import { Socket } from 'socket.io';
import {
  REALTIME_CORE_DEFAULTS,
  RealtimeConfigService,
  type RateLimitBudget,
} from './config';
import { RealtimeRateLimitedException } from './errors';

export type EventBucketClassifier = (
  eventName: string,
) => string | null | undefined;

export interface WsRateLimitPolicy {
  classify: EventBucketClassifier;
  budgets: Readonly<Record<string, RateLimitBudget>>;
  maxThrottledConsecutiveWindows?: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
}

interface SocketRateState {
  buckets: Map<string, BucketState>;
  consecutiveThrottledWindows: number;
  lastThrottledWindow: number;
  lastActive: number;
}

@Injectable()
export class WsRateLimiter {
  private readonly logger = new Logger(WsRateLimiter.name);
  private readonly socketStates = new Map<string, SocketRateState>();

  constructor(@Optional() private readonly config?: RealtimeConfigService) {}

  public consumeOrThrow(
    client: Socket,
    eventName: string,
    policy?: WsRateLimitPolicy,
  ): void {
    if (!policy) {
      return;
    }

    const bucketKey = policy.classify(eventName);
    if (!bucketKey) {
      return;
    }

    const budgetConfig = policy.budgets[bucketKey];
    if (!budgetConfig) {
      return;
    }

    const rlCfg = this.config?.getRateLimiterConfig();
    const maxTrackedSockets =
      rlCfg?.maxTrackedSockets ??
      REALTIME_CORE_DEFAULTS.rateLimiter.maxTrackedSockets;
    const staleSocketTtlMs =
      rlCfg?.staleSocketTtlMs ??
      REALTIME_CORE_DEFAULTS.rateLimiter.staleSocketTtlMs;
    const maxConsecutive =
      policy.maxThrottledConsecutiveWindows ??
      rlCfg?.maxThrottledConsecutiveWindows ??
      REALTIME_CORE_DEFAULTS.rateLimiter.maxThrottledConsecutiveWindows;

    const { budgetPerSec, burst } = budgetConfig;
    const now = Date.now();
    let state = this.socketStates.get(client.id);

    if (!state) {
      if (this.socketStates.size > maxTrackedSockets) {
        const staleCutoff = now - staleSocketTtlMs;
        for (const [k, s] of this.socketStates) {
          if (s.lastActive < staleCutoff) {
            this.socketStates.delete(k);
          }
        }
      }
      state = {
        buckets: new Map<string, BucketState>(),
        consecutiveThrottledWindows: 0,
        lastThrottledWindow: 0,
        lastActive: now,
      };
      this.socketStates.set(client.id, state);
    }

    state.lastActive = now;
    let bucket = state.buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        tokens: burst,
        lastRefill: now,
      };
      state.buckets.set(bucketKey, bucket);
    }

    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * budgetPerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    const currentWindow = Math.floor(now / 1000);
    if (state.lastThrottledWindow === currentWindow) {
      // Already counted as throttled within this 1s window
    } else if (state.lastThrottledWindow === currentWindow - 1) {
      state.consecutiveThrottledWindows += 1;
      state.lastThrottledWindow = currentWindow;
    } else {
      state.consecutiveThrottledWindows = 1;
      state.lastThrottledWindow = currentWindow;
    }

    if (state.consecutiveThrottledWindows >= maxConsecutive) {
      this.logger.warn(
        `Socket ${client.id} exceeded rate limits in ${state.consecutiveThrottledWindows} consecutive windows. Disconnecting socket.`,
      );
      if (typeof client.disconnect === 'function') {
        client.disconnect(true);
      }
    }

    throw new RealtimeRateLimitedException('Too many events');
  }

  public cleanupSocket(socketId: string): void {
    this.socketStates.delete(socketId);
  }
}
