import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import {
  ILibrarySyncPort,
  LIBRARY_SYNC_PORT,
} from '../../library/library-sync.port';

export interface ZoteroStreamSubscription {
  workspaceId: string;
  bindingId: string;
  libraryType: 'user' | 'group';
  libraryId: string;
  apiKey: string;
}

export interface ZoteroStreamNotification {
  event: 'updated' | 'deleted' | 'topicUpdated';
  topic?: string;
  libraryType?: 'user' | 'group';
  libraryId?: string;
  version?: number;
}

@Injectable()
export class ZoteroWebSocketListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ZoteroWebSocketListener.name);
  private readonly endpoint = 'wss://stream.zotero.org';
  private readonly subscriptions = new Map<string, ZoteroStreamSubscription>();
  private ws: any = null;
  private isDestroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    @Optional() private readonly connectionService?: ZoteroConnectionService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly configService?: ConfigService,
    @Optional()
    @Inject(LIBRARY_SYNC_PORT)
    private readonly libraryBridge?: ILibrarySyncPort,
  ) {}

  async onModuleInit() {
    // 1. Recover persistent subscriptions from active PostgreSQL bindings
    await this.recoverSubscriptionsFromDatabase();

    // 2. Initialize streaming socket if enabled
    const isStreamingEnabled =
      process.env.ZOTERO_STREAMING_ENABLED === 'true' ||
      this.configService?.get('ZOTERO_STREAMING_ENABLED') === 'true';

    if (isStreamingEnabled) {
      this.connect();
    } else {
      this.logger.log(
        'Zotero WebSocket Streaming is in standby. Set ZOTERO_STREAMING_ENABLED=true to connect live stream.',
      );
    }
  }

  async onModuleDestroy() {
    this.isDestroyed = true;
    this.cleanupHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Recovers active subscriptions from persistent ZoteroBinding records.
   */
  async recoverSubscriptionsFromDatabase(): Promise<void> {
    if (!this.prisma || !this.connectionService) return;

    try {
      const activeBindings = await this.prisma.zoteroBinding.findMany({
        where: {
          syncDirection: { in: ['read_only', 'two_way'] },
          connection: { status: 'active' },
        },
        include: { connection: true },
      });

      for (const binding of activeBindings) {
        try {
          const apiKey = await this.connectionService.getDecryptedApiKey(
            binding.connectionId,
            binding.workspaceId,
          );

          this.registerSubscription({
            workspaceId: binding.workspaceId,
            bindingId: binding.id,
            libraryType: binding.remoteLibraryType as 'user' | 'group',
            libraryId: binding.remoteLibraryId,
            apiKey,
          });
        } catch (err: any) {
          this.logger.warn(
            `Failed to recover subscription for binding ${binding.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(
        `Recovered ${this.subscriptions.size} Zotero stream subscriptions from database.`,
      );
    } catch (err: any) {
      this.logger.error(
        `Error recovering Zotero subscriptions: ${err.message}`,
      );
    }
  }

  /**
   * Registers a library subscription to listen for real-time remote updates.
   */
  registerSubscription(sub: ZoteroStreamSubscription): void {
    const topicKey = `/${sub.libraryType === 'user' ? 'users' : 'groups'}/${sub.libraryId}`;
    this.subscriptions.set(topicKey, sub);

    if (this.ws && this.ws.readyState === 1) {
      this.sendSubscription(sub);
    }
  }

  /**
   * Unregisters a subscription and closes remote topic listening.
   */
  unregisterSubscription(topicKey: string): void {
    this.subscriptions.delete(topicKey);
  }

  /**
   * Processes an incoming raw string message received from Zotero stream socket.
   */
  async handleIncomingMessage(
    rawMessage: string,
  ): Promise<{ enqueued: boolean; duplicate?: boolean; topic?: string }> {
    let notification: ZoteroStreamNotification;
    try {
      notification = JSON.parse(rawMessage);
    } catch {
      this.logger.warn(`Failed to parse stream message: ${rawMessage}`);
      return { enqueued: false };
    }

    const topic =
      notification.topic ||
      (notification.libraryType && notification.libraryId
        ? `/${notification.libraryType === 'user' ? 'users' : 'groups'}/${notification.libraryId}`
        : undefined);

    if (!topic) {
      this.logger.warn(
        `Stream notification missing topic or library identifiers: ${rawMessage}`,
      );
      return { enqueued: false };
    }

    const sub = this.subscriptions.get(topic);
    if (!sub) {
      this.logger.debug(`No active subscription found for topic ${topic}`);
      return { enqueued: false, topic };
    }

    const dedupeKey = `zotero_stream_${sub.bindingId}_${topic}_${notification.event}_${notification.version || 0}`;

    this.logger.log(
      `Zotero stream notification on topic ${topic} -> persisting durable Outbox event for binding ${sub.bindingId} (DedupeKey: ${dedupeKey})`,
    );

    if (this.libraryBridge) {
      try {
        const res = await this.libraryBridge.publishIntegrationEvent({
          workspaceId: sub.workspaceId,
          aggregateId: sub.bindingId,
          eventType: 'library.zotero.stream_event_received',
          dedupeKey,
          payload: {
            bindingId: sub.bindingId,
            topic,
            event: notification.event,
            version: notification.version,
            idempotencyKey: dedupeKey,
            timestamp: new Date().toISOString(),
          },
        });
        if (res.id.startsWith('deduped-')) {
          this.logger.debug(`Duplicate stream event ignored for key ${dedupeKey}`);
          return { enqueued: false, duplicate: true, topic };
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to persist stream event to Outbox: ${err.message}`,
        );
        throw err;
      }
    }

    return { enqueued: true, duplicate: false, topic };
  }

  /**
   * Connects to Zotero WebSocket streaming endpoint.
   */
  private connect(): void {
    if (this.isDestroyed) return;

    try {
      const WebSocketClass = (global as any).WebSocket || require('ws');
      this.ws = new WebSocketClass(this.endpoint);

      this.ws.on('open', () => {
        this.logger.log('Connected to Zotero WebSocket stream server');
        this.reconnectAttempt = 0;
        this.resubscribeAll();
        this.startHeartbeat();
        this.triggerCatchUpSync().catch((err) =>
          this.logger.warn(`Catch-up sync trigger error: ${err.message}`),
        );
      });

      this.ws.on('message', async (data: any) => {
        try {
          const str = data.toString('utf-8');
          await this.handleIncomingMessage(str);
        } catch (err: any) {
          this.logger.error(
            `Error processing stream message: ${err.message}`,
          );
        }
      });

      this.ws.on('close', (code: number, reason: string) => {
        this.logger.warn(
          `Zotero stream connection closed: code=${code}, reason=${reason}. Scheduling reconnect.`,
        );
        this.cleanupHeartbeat();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: any) => {
        this.logger.error(`Zotero stream socket error: ${err.message}`);
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to initialize WebSocket client: ${err.message}`,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Schedules reconnection with full jitter exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimer) return;

    this.reconnectAttempt++;
    const baseDelay = 1000;
    const maxDelay = 60000;
    const factor = Math.min(Math.pow(2, this.reconnectAttempt) * baseDelay, maxDelay);
    const delay = Math.floor(Math.random() * factor);

    this.logger.log(
      `Scheduling Zotero stream reconnect attempt #${this.reconnectAttempt} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendSubscription(sub: ZoteroStreamSubscription): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    const topic = `/${sub.libraryType === 'user' ? 'users' : 'groups'}/${sub.libraryId}`;
    const payload = JSON.stringify({
      action: 'subscribe',
      subscriptions: [
        {
          apiKey: sub.apiKey,
          topics: [topic],
        },
      ],
    });

    try {
      this.ws.send(payload);
      this.logger.debug(`Subscribed to Zotero stream topic: ${topic}`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to send stream subscription for ${topic}: ${err.message}`,
      );
    }
  }

  private resubscribeAll(): void {
    for (const [, sub] of this.subscriptions) {
      this.sendSubscription(sub);
    }
  }

  /**
   * Enqueues durable catch-up sync Outbox events upon reconnect with 1-minute window deduplication.
   */
  private async triggerCatchUpSync(): Promise<void> {
    if (!this.libraryBridge) return;

    const timeWindow = Math.floor(Date.now() / 60000);

    for (const [, sub] of this.subscriptions) {
      const topic = `/${sub.libraryType === 'user' ? 'users' : 'groups'}/${sub.libraryId}`;
      const dedupeKey = `zotero_catchup_${sub.bindingId}_${timeWindow}`;
      try {
        await this.libraryBridge.publishIntegrationEvent({
          workspaceId: sub.workspaceId,
          aggregateId: sub.bindingId,
          eventType: 'library.zotero.stream_event_received',
          dedupeKey,
          payload: {
            bindingId: sub.bindingId,
            topic,
            event: 'catchUp',
            idempotencyKey: dedupeKey,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err: any) {
        this.logger.warn(
          `Failed to enqueue catch-up stream event for binding ${sub.bindingId}: ${err.message}`,
        );
      }
    }
  }

  private startHeartbeat(): void {
    this.cleanupHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        if (typeof this.ws.ping === 'function') {
          this.ws.ping();
        }
      }
    }, 30000);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
