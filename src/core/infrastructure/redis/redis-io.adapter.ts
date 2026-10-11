import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
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
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to connect Socket.IO Redis adapter (${msg}). Falling back to in-memory adapter.`,
      );
      this.adapterConstructor = null;
    }
  }

  createIOServer(
    port: number,
    options?: ServerOptions,
  ): ReturnType<IoAdapter['createIOServer']> {
    const serverOptions: ServerOptions = {
      ...(options as ServerOptions),
      path: options?.path ?? '/socket.io/',
      cors: options?.cors ?? {
        origin: true,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
      maxHttpBufferSize: 1e7, // 10MB
      connectTimeout: 45000,
      allowUpgrades: true,
    };
    const server = super.createIOServer(port, serverOptions) as Server;
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
