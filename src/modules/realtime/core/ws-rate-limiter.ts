import { Injectable, Logger, Optional } from '@nestjs/common';
import { Socket } from 'socket.io';
import { RealtimeConfigService } from './realtime.config';
import { RealtimeRateLimitedException } from './ws-errors';

export type RealtimeEventClass =
  'cursor' | 'update' | 'chat' | 'joinLeave' | 'other';

export type EventClassClassifier = (eventName: string) => RealtimeEventClass;

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

  public consumeOrThrow(
    client: Socket,
    eventName: string,
    classifier?: EventClassClassifier,
  ): void {
    const eventClass: RealtimeEventClass = classifier
      ? classifier(eventName)
      : 'other';
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
      if (this.socketStates.size > 5000) {
        const staleCutoff = now - 300_000;
        for (const [k, s] of this.socketStates) {
          if (s.lastActive < staleCutoff) {
            this.socketStates.delete(k);
          }
        }
      }
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
