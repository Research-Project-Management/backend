import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { SyncMetricsService } from '../../sync-core/sync.metrics';

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
    @Optional() private readonly metricsService?: SyncMetricsService,
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

  /**
   * Recovers persistent subscriptions directly from PostgreSQL database on startup.
   */
  async recoverSubscriptionsFromDatabase(): Promise<void> {
    if (!this.prisma || !this.connectionService) return;

    try {
      const activeBindings = await this.prisma.zoteroBinding.findMany({
        where: {
          connection: {
            status: 'active',
          },
        },
        include: {
          connection: true,
        },
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
            `Failed to recover stream subscription for binding ${binding.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(
        `Recovered ${this.subscriptions.size} active Zotero streaming subscriptions from PostgreSQL.`,
      );
    } catch (err: any) {
      this.logger.error(
        `Error recovering stream subscriptions on startup: ${err.message}`,
      );
    }
  }

  /**
   * Registers a library subscription to listen for real-time remote updates.
   */
  registerSubscription(sub: ZoteroStreamSubscription): void {
    const topicKey = `/${sub.libraryType === 'user' ? 'users' : 'groups'}/${sub.libraryId}`;
    this.subscriptions.set(topicKey, sub);
    this.logger.log(`Registered Zotero stream topic: ${topicKey}`);

    if (this.ws && this.ws.readyState === 1) {
      this.sendSubscription(sub);
    }
  }

  /**
   * Unregisters a subscription.
   */
  unregisterSubscription(topicKey: string): void {
    this.subscriptions.delete(topicKey);
  }

  /**
   * Handles incoming stream notification strictly via durable Outbox queue.
   * Zero direct worker execution or setImmediate fire-and-forget.
   */
  /**
   * Handles incoming stream notification strictly via durable Outbox queue with database-enforced dedupeKey.
   * Zero direct worker execution or setImmediate fire-and-forget.
   */
  async handleStreamNotification(
    notification: ZoteroStreamNotification,
  ): Promise<{ enqueued: boolean; duplicate?: boolean; topic?: string }> {
    const topic = notification.topic;
    if (!topic) return { enqueued: false };

    this.metricsService?.incrementCounter('zotero_stream_received_total');

    const sub = this.subscriptions.get(topic);
    if (!sub) {
      this.logger.debug(`No active subscription found for topic ${topic}`);
      return { enqueued: false, topic };
    }

    const dedupeKey = `zotero_stream_${sub.bindingId}_${topic}_${notification.event}_${notification.version || 0}`;

    this.logger.log(
      `Zotero stream notification on topic ${topic} -> persisting durable Outbox event for binding ${sub.bindingId} (DedupeKey: ${dedupeKey})`,
    );

    // Write durable OutboxEvent to PostgreSQL with atomic create-if-absent
    if (this.prisma) {
      try {
        await this.prisma.outboxEvent.create({
          data: {
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
          },
        });
      } catch (err: any) {
        if (
          err.code === 'P2002' &&
          (Array.isArray(err.meta?.target)
            ? err.meta.target.includes('dedupeKey') ||
              err.meta.target.includes('dedupe_key')
            : true)
        ) {
          this.metricsService?.incrementCounter('zotero_stream_deduped_total');
          this.logger.debug(
            `Duplicate stream event ignored for key ${dedupeKey}`,
          );
          return { enqueued: false, duplicate: true, topic };
        }
        this.logger.error(
          `Failed to persist stream event to Outbox: ${err.message}`,
        );
        throw err;
      }
    }

    return { enqueued: true, duplicate: false, topic };
  }

  private connect(): void {
    if (this.isDestroyed) return;

    try {
      const WebSocketClass =
        (globalThis as any).WebSocket ||
        (typeof WebSocket !== 'undefined' ? WebSocket : null);

      if (!WebSocketClass) {
        this.logger.warn(
          'WebSocket client not available in current runtime environment. Periodic reconciliation is active.',
        );
        return;
      }

      this.logger.log(`Connecting to Zotero live stream at ${this.endpoint}`);
      this.ws = new WebSocketClass(this.endpoint);

      this.ws.onopen = () => {
        this.logger.log('Connected to Zotero live streaming API');
        this.reconnectAttempt = 0;
        this.resubscribeAll();
        this.startHeartbeat();
        void this.triggerCatchUpSync();
      };

      this.ws.onmessage = (event: any) => {
        try {
          const raw =
            typeof event.data === 'string'
              ? event.data
              : event.data?.toString();
          const parsed = JSON.parse(raw);
          void this.handleStreamNotification(parsed);
        } catch (err: any) {
          this.logger.warn(
            `Failed to parse incoming Zotero stream message: ${err.message}`,
          );
        }
      };

      this.ws.onclose = () => {
        this.logger.warn(
          'Zotero streaming connection closed. Scheduling reconnect.',
        );
        this.cleanupHeartbeat();
        this.scheduleReconnect();
      };

      this.ws.onerror = (err: any) => {
        this.logger.warn(
          `Zotero stream socket error: ${err.message || 'connection error'}`,
        );
      };
    } catch (err: any) {
      this.logger.error(
        `Error initializing Zotero streaming connection: ${err.message}`,
      );
      this.scheduleReconnect();
    }
  }

  private sendSubscription(sub: ZoteroStreamSubscription): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    const topic = `/${sub.libraryType === 'user' ? 'users' : 'groups'}/${sub.libraryId}`;
    const payload = {
      action: 'createSubscriptions',
      subscriptions: [
        {
          apiKey: sub.apiKey,
          topics: [topic],
        },
      ],
    };

    this.ws.send(JSON.stringify(payload));
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
    if (!this.prisma) return;

    const timeWindow = Math.floor(Date.now() / 60000);

    for (const [, sub] of this.subscriptions) {
      const dedupeKey = `zotero_catchup_${sub.bindingId}_${timeWindow}`;
      try {
        await this.prisma.outboxEvent.create({
          data: {
            workspaceId: sub.workspaceId,
            aggregateId: sub.bindingId,
            eventType: 'library.zotero.stream_event_received',
            dedupeKey,
            payload: {
              bindingId: sub.bindingId,
              topic: `/${sub.libraryType === 'user' ? 'users' : 'groups'}/${sub.libraryId}`,
              event: 'catchUp',
              idempotencyKey: dedupeKey,
              timestamp: new Date().toISOString(),
            },
          },
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          this.logger.debug(
            `Catch-up sync event already enqueued for window ${dedupeKey}`,
          );
          continue;
        }
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

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimer) return;

    this.reconnectAttempt++;
    const delayMs = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt) * (0.5 + Math.random() * 0.5),
      60000,
    );

    this.logger.log(
      `Reconnecting to Zotero stream in ${Math.round(delayMs)}ms (attempt ${this.reconnectAttempt})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    this.cleanupHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (typeof this.ws.close === 'function') {
          this.ws.close();
        }
      } catch (err: any) {
        this.logger.debug(`Error closing stream websocket: ${err.message}`);
      }
      this.ws = null;
    }
    this.subscriptions.clear();
  }
}
