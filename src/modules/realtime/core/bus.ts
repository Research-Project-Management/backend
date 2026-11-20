import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { RedisCacheService } from '@/core';

export const REALTIME_BUS_CHANNEL = 'realtime:service:bus' as const;
export const REALTIME_BUS_MODE = 'REALTIME_BUS_MODE' as const;
export type RealtimeBusMode = 'publisher' | 'subscriber';

export interface ChatReactionBroadcastPayload {
  conversationId: string;
  messageId: string;
  userId: string;
  emoji: string;
  action: 'add' | 'remove';
}

export type RealtimeBusEnvelope =
  | {
      type: 'chat:message';
      conversationId: string;
      message: unknown;
      memberIds?: string[];
    }
  | {
      type: 'chat:reaction';
      conversationId: string;
      payload: ChatReactionBroadcastPayload;
    }
  | {
      type: 'work-item:event';
      projectId: string;
      event: string;
      payload: Record<string, unknown>;
    }
  | {
      type: 'member:removed';
      projectId: string;
      userId: string;
    }
  | {
      type: 'pages:project-event';
      projectId: string;
      event: string;
      payload: unknown;
    }
  | {
      type: 'member:updated';
      projectId: string;
      userId: string;
      role?: string;
    }
  | {
      type: 'ownership:transferred';
      projectId: string;
      previousOwnerId?: string;
      newOwnerId?: string;
    }
  | {
      type: 'project:deleted';
      projectId: string;
    };

export type RealtimeBusHandler = (
  envelope: RealtimeBusEnvelope,
) => void | Promise<void>;

interface BusSubscriberClient {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  subscribe?: (channel: string) => Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
}

@Injectable()
export class RealtimeEventBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeEventBus.name);
  private readonly handlers = new Set<RealtimeBusHandler>();
  private subscriber: BusSubscriberClient | null = null;
  private subscriberReady = false;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional()
    @Inject(REALTIME_BUS_MODE)
    private readonly mode: RealtimeBusMode = 'subscriber',
  ) {}

  public getMode(): RealtimeBusMode {
    return this.mode;
  }

  public async onModuleInit(): Promise<void> {
    if (this.mode === 'publisher') {
      this.subscriberReady = false;
      return;
    }

    if (!this.redis || !this.redis.isReady()) {
      this.subscriberReady = false;
      return;
    }

    const baseClient = this.redis.getClient?.();
    if (!baseClient || typeof baseClient.duplicate !== 'function') {
      return;
    }

    try {
      const sub = baseClient.duplicate() as BusSubscriberClient;
      sub.on?.('error', (err: Error) => {
        this.logger.warn(`Realtime bus subscriber error: ${err.message}`);
      });
      sub.on?.('message', (channel: string, raw: string) => {
        if (channel !== REALTIME_BUS_CHANNEL) {
          return;
        }
        try {
          const parsed = JSON.parse(raw) as RealtimeBusEnvelope;
          if (parsed && typeof parsed.type === 'string') {
            void this.dispatchLocal(parsed);
          }
        } catch (err: unknown) {
          this.logger.warn(
            `Invalid realtime bus payload: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });

      if (typeof sub.subscribe === 'function') {
        await sub.subscribe(REALTIME_BUS_CHANNEL);
      }

      this.subscriber = sub;
      this.subscriberReady = true;
    } catch (err: unknown) {
      this.subscriberReady = false;
      this.logger.warn(
        `Failed to initialize Redis realtime bus subscriber (using in-process fallback): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.subscriberReady = false;
    this.handlers.clear();

    const sub = this.subscriber;
    this.subscriber = null;
    if (!sub) {
      return;
    }

    try {
      if (typeof sub.quit === 'function') {
        await sub.quit();
      } else {
        sub.disconnect?.();
      }
    } catch {
      sub.disconnect?.();
    }
  }

  public subscribe(handler: RealtimeBusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  public async publish(envelope: RealtimeBusEnvelope): Promise<void> {
    if (
      this.redis?.isReady() &&
      (this.mode === 'publisher' || this.subscriberReady)
    ) {
      const client = this.redis.getClient?.();
      if (client && typeof client.publish === 'function') {
        try {
          await client.publish(REALTIME_BUS_CHANNEL, JSON.stringify(envelope));
          return;
        } catch (err: unknown) {
          this.logger.warn(
            `Redis realtime bus publish failed, falling back to local dispatch: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    await this.dispatchLocal(envelope);
  }

  private async dispatchLocal(envelope: RealtimeBusEnvelope): Promise<void> {
    for (const handler of Array.from(this.handlers)) {
      try {
        await handler(envelope);
      } catch (err: unknown) {
        this.logger.warn(
          `Realtime bus handler error for ${envelope.type}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
