import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Logger } from '@nestjs/common';

/**
 * Enterprise Redis IO Adapter for Socket.IO
 * Enables cross-node room fan-out, horizontal pod scaling,
 * and graceful fallback to in-memory adapter when Redis is offline.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: any = null;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  async connectToRedis(redisUrl: string): Promise<void> {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_REDIS === 'true'
    ) {
      this.logger.log(
        'Redis is disabled or in test mode. Operating with default in-memory Socket.IO adapter.',
      );
      return;
    }

    try {
      this.pubClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) =>
          times > 3 ? null : Math.min(times * 500, 2000),
        lazyConnect: true,
        enableOfflineQueue: false,
      });

      this.subClient = this.pubClient.duplicate();

      this.pubClient.on('error', (err) => {
        this.logger.warn(`Redis adapter pubClient error: ${err.message}`);
      });
      this.subClient.on('error', (err) => {
        this.logger.warn(`Redis adapter subClient error: ${err.message}`);
      });

      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
      this.logger.log(
        'Socket.IO Redis adapter connected successfully (multi-node horizontal fan-out active)',
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to connect Socket.IO Redis adapter (${err?.message || err}). Falling back to in-memory adapter.`,
      );
      this.adapterConstructor = null;
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  async close(): Promise<void> {
    if (this.pubClient) {
      try {
        await this.pubClient.quit();
      } catch {
        this.pubClient.disconnect();
      }
      this.pubClient = null;
    }
    if (this.subClient) {
      try {
        await this.subClient.quit();
      } catch {
        this.subClient.disconnect();
      }
      this.subClient = null;
    }
  }
}
