import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type Redis from 'ioredis';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { isOriginAllowed } from '../../http/setup/allowed-origins';
import { getErrorMessage } from '../../utils/error.util';
import {
  closeRedisClient,
  createRedisClient,
  isRedisDisabled,
} from './client.factory';

export interface RedisIoTransportOptions {
  path?: string;
  transports?: Array<'websocket' | 'polling'>;
  pingTimeoutMs?: number;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  maxMessageSizeBytes?: number;
}

/**
 * Enterprise Redis Streams IO Adapter for Socket.IO.
 * Uses a single Redis connection (`@socket.io/redis-streams-adapter`) with
 * bounded stream length (`maxLen: 10_000`) and Connection State Recovery so
 * clients automatically replay missed events after brief network drops.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private redisClient: Redis | null = null;

  constructor(
    appOrHttpServer?: INestApplicationContext,
    private readonly transportOptions?: RedisIoTransportOptions,
  ) {
    super(appOrHttpServer);
  }

  async connectToRedis(redisUrl: string): Promise<void> {
    if (isRedisDisabled()) {
      this.logger.log(
        'Redis is disabled or in test mode. Operating with default in-memory Socket.IO adapter.',
      );
      return;
    }

    try {
      this.redisClient = createRedisClient(redisUrl, {
        label: 'SocketIoStreamsAdapter',
        logger: this.logger,
        maxRetriesPerRequest: 3,
      });

      this.redisClient.on('error', (err) => {
        this.logger.warn(`Redis streams adapter error: ${err.message}`);
      });

      await this.redisClient.connect();

      this.adapterConstructor = createAdapter(this.redisClient, {
        streamName: 'flux:socket.io',
        maxLen: 10_000,
      });
      this.logger.log(
        'Socket.IO Redis Streams adapter connected (multi-node fan-out + Connection State Recovery active)',
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to connect Socket.IO Redis Streams adapter (${getErrorMessage(err)}). Falling back to in-memory adapter.`,
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
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false,
      },
    };
    const server = super.createIOServer(port, serverOptions) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  async close(): Promise<void> {
    const client = this.redisClient;
    this.redisClient = null;
    await closeRedisClient(client);
  }
}
