import { Injectable, Logger, Optional } from '@nestjs/common';
import { Socket } from 'socket.io';
import { RealtimeConfigService } from './realtime.config';
import { RealtimeRateLimitedException } from './ws-errors';

export type RealtimeEventClass =
  'cursor' | 'update' | 'chat' | 'joinLeave' | 'other';

/**
 * Lookup Table Pattern: Declarative event-to-rate-bucket classification map.
 */
export const EVENT_RATE_CLASS_MAP: Readonly<
  Record<string, RealtimeEventClass>
> = Object.freeze({
  'doc:cursor': 'cursor',
  'doc:update': 'update',
  'doc:sync:step1': 'update',
  'doc:sync:step2': 'update',
  'doc:sync:update': 'update',
  'project:chat:send': 'chat',
  'project:chat:history': 'chat',
  'chat:history': 'chat',
  'project:join': 'joinLeave',
  'project:leave': 'joinLeave',
  'doc:join': 'joinLeave',
  'doc:leave': 'joinLeave',
});

export function classifyEvent(event: string): RealtimeEventClass {
  return EVENT_RATE_CLASS_MAP[event] ?? 'other';
}

interface BucketState {
  tokens: number;
  lastRefill: number;
}

interface SocketRateState {
  buckets: Map<RealtimeEventClass, BucketState>;
  consecutiveThrottledWindows: number;
  lastThrottledWindow: number;
  lastActive: number;
}

@Injectable()
export class WsRateLimiter {
  private readonly logger = new Logger(WsRateLimiter.name);
  private readonly socketStates = new Map<string, SocketRateState>();

  constructor(@Optional() private readonly config?: RealtimeConfigService) {}

  public consumeOrThrow(client: Socket, eventName: string): void {
    const eventClass = classifyEvent(eventName);
    if (eventClass === 'other') {
      return;
    }

    const limits = this.config?.getRateLimits();
    const budgetConfig = limits ? limits[eventClass] : null;
    if (!budgetConfig) {
      return;
    }

    const { budgetPerSec, burst } = budgetConfig;
    const now = Date.now();
    let state = this.socketStates.get(client.id);

    if (!state) {
      state = {
        buckets: new Map<RealtimeEventClass, BucketState>(),
        consecutiveThrottledWindows: 0,
        lastThrottledWindow: 0,
        lastActive: now,
      };
      this.socketStates.set(client.id, state);
    }

    state.lastActive = now;
    let bucket = state.buckets.get(eventClass);
    if (!bucket) {
      bucket = {
        tokens: burst,
        lastRefill: now,
      };
      state.buckets.set(eventClass, bucket);
    }

    // Refill tokens according to elapsed time
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * budgetPerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    // Budget exceeded -> throttle
    const currentWindow = Math.floor(now / 1000);
    if (state.lastThrottledWindow === currentWindow) {
      // Already marked as throttled in this 1-second window
    } else if (state.lastThrottledWindow === currentWindow - 1) {
      state.consecutiveThrottledWindows += 1;
      state.lastThrottledWindow = currentWindow;
    } else {
      state.consecutiveThrottledWindows = 1;
      state.lastThrottledWindow = currentWindow;
    }

    const maxConsecutive = limits?.maxThrottledConsecutiveWindows ?? 5;
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
