import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { getErrorMessage } from '../../utils/error.util';
import {
  closeRedisClient,
  createRedisClient,
  isRedisDisabled,
  resolveLaneRedisUrl,
} from './client.factory';

export type PubSubMessageHandler = (channel: string, message: string) => void;

/**
 * Dedicated Redis Pub/Sub Adapter (`REDIS_REALTIME_URL` -> fallback `REDIS_URL`).
 * Isolates subscriber TCP connections via `duplicate()` so SUBSCRIBE mode
 * never blocks cache GET/SET traffic.
 */
@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private pubReady = false;
  private subReady = false;
  private readonly listeners = new Map<string, Set<PubSubMessageHandler>>();

  constructor(private readonly configService: ConfigService) {}

  public onModuleInit(): void {
    if (isRedisDisabled()) {
      return;
    }

    const url = resolveLaneRedisUrl(this.configService, 'pubsub');
    try {
      this.pubClient = createRedisClient(url, {
        label: 'PubSub',
        logger: this.logger,
      });

      this.pubClient.on('ready', () => {
        this.pubReady = true;
      });
      this.pubClient.on('close', () => {
        this.pubReady = false;
      });
      this.pubClient.on('error', (err: Error) => {
        this.pubReady = false;
        this.logger.warn(`Redis Pub/Sub publisher unavailable: ${err.message}`);
      });

      this.pubClient.connect().catch((err: unknown) => {
        this.logger.warn(
          `Deferred Redis Pub/Sub connect: ${getErrorMessage(err)}`,
        );
      });
    } catch (err: unknown) {
      this.logger.warn(`Redis Pub/Sub init warning: ${getErrorMessage(err)}`);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    this.pubReady = false;
    this.subReady = false;

    const sub = this.subClient;
    const pub = this.pubClient;
    this.subClient = null;
    this.pubClient = null;
    await Promise.all([closeRedisClient(sub), closeRedisClient(pub)]);
  }

  public isEnabled(): boolean {
    return !isRedisDisabled() && this.pubClient !== null;
  }

  public isReady(): boolean {
    return this.pubReady && this.pubClient !== null;
  }

  public async publish(channel: string, message: string): Promise<boolean> {
    if (!this.isReady() || !this.pubClient) {
      return false;
    }
    try {
      await this.pubClient.publish(channel, message);
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Redis Pub/Sub publish failed on "${channel}": ${getErrorMessage(err)}`,
      );
      return false;
    }
  }

  public async subscribe(
    channel: string,
    handler: PubSubMessageHandler,
  ): Promise<() => Promise<void>> {
    let channelHandlers = this.listeners.get(channel);
    const isNewChannel = !channelHandlers;
    if (!channelHandlers) {
      channelHandlers = new Set();
      this.listeners.set(channel, channelHandlers);
    }
    channelHandlers.add(handler);

    if (isNewChannel && this.pubClient && !isRedisDisabled()) {
      await this.ensureSubscriberConnected();
      if (this.subClient && this.subReady) {
        await this.subClient.subscribe(channel).catch((err: unknown) => {
          this.logger.warn(
            `Redis Pub/Sub subscribe failed on "${channel}": ${getErrorMessage(err)}`,
          );
        });
      }
    }

    return async () => {
      const set = this.listeners.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.listeners.delete(channel);
        if (this.subClient && this.subReady) {
          await this.subClient.unsubscribe(channel).catch(() => undefined);
        }
      }
    };
  }

  private async ensureSubscriberConnected(): Promise<void> {
    if (this.subClient || !this.pubClient) return;

    const sub = this.pubClient.duplicate();
    sub.on('ready', () => {
      this.subReady = true;
      for (const ch of this.listeners.keys()) {
        void sub.subscribe(ch).catch((err: unknown) => {
          this.logger.warn(
            `Redis Pub/Sub re-subscribe failed on "${ch}": ${getErrorMessage(err)}`,
          );
        });
      }
    });
    sub.on('close', () => {
      this.subReady = false;
    });
    sub.on('error', (err: Error) => {
      this.subReady = false;
      this.logger.warn(`Redis Pub/Sub subscriber error: ${err.message}`);
    });
    sub.on('message', (channel: string, message: string) => {
      const handlers = this.listeners.get(channel);
      if (!handlers) return;
      for (const fn of Array.from(handlers)) {
        try {
          fn(channel, message);
        } catch (err: unknown) {
          this.logger.warn(
            `Pub/Sub handler error on "${channel}": ${getErrorMessage(err)}`,
          );
        }
      }
    });

    try {
      await sub.connect();
      this.subClient = sub;
      this.subReady = true;
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to connect Redis Pub/Sub subscriber: ${getErrorMessage(err)}`,
      );
      sub.disconnect();
    }
  }
}
