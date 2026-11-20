import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { isOriginAllowed } from '../../http/setup/allowed-origins';

export interface RedisIoTransportOptions {
  path?: string;
  transports?: Array<'websocket' | 'polling'>;
  pingTimeoutMs?: number;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  maxMessageSizeBytes?: number;
}

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

  constructor(
    appOrHttpServer?: INestApplicationContext,
    private readonly transportOptions?: RedisIoTransportOptions,
  ) {
    super(appOrHttpServer);
  }

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
    const defaultCors = {
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        callback(null, isOriginAllowed(origin));
      },
      credentials: true,
    };

    const parsedEnvMaxSize = process.env.REALTIME_MAX_MESSAGE_SIZE_BYTES
      ? parseInt(process.env.REALTIME_MAX_MESSAGE_SIZE_BYTES, 10)
      : NaN;
    const fallbackMaxMessageSizeBytes =
      Number.isFinite(parsedEnvMaxSize) && parsedEnvMaxSize > 0
        ? parsedEnvMaxSize
        : 1024 * 1024; // 1MB (RT-07, SC-004)

    const serverOptions: ServerOptions = {
      ...(options as ServerOptions),
      path: options?.path ?? this.transportOptions?.path ?? '/socket.io/',
      cors: options?.cors ?? defaultCors,
      allowRequest: (req, callback) => {
        const origin = req.headers?.origin;
        if (!isOriginAllowed(origin)) {
          return callback('ORIGIN_NOT_ALLOWED', false);
        }
        if (typeof options?.allowRequest === 'function') {
          return options.allowRequest(req, callback);
        }
        callback(null, true);
      },
      transports: this.transportOptions?.transports ?? ['websocket', 'polling'],
      pingTimeout: this.transportOptions?.pingTimeoutMs ?? 60000,
      pingInterval: this.transportOptions?.pingIntervalMs ?? 25000,
      maxHttpBufferSize:
        options?.maxHttpBufferSize ??
        this.transportOptions?.maxMessageSizeBytes ??
        fallbackMaxMessageSizeBytes,
      connectTimeout: this.transportOptions?.connectTimeoutMs ?? 45000,
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
