import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
import { FileUploadedEvent } from '../../domain/events/file-uploaded.event';
import { FileDownloadedEvent } from '../../domain/events/file-downloaded.event';
import { FileTrashedEvent } from '../../domain/events/file-trashed.event';
import { FileDeletedEvent } from '../../domain/events/file-deleted.event';
import { QuotaExceededEvent } from '../../domain/events/quota-exceeded.event';

export interface StorageOutboxEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, any>;
}

/**
 * StorageEventOutboxService
 * Implements durable event streaming (Redis Streams & Pub/Sub) for all storage lifecycle operations,
 * coordinating with downstream consumers (Document, WorkItem, Library, AI Agents).
 * Aligns with tigris-agent-kit event coordination specifications.
 */
@Injectable()
export class StorageEventOutboxService {
  private readonly logger = new Logger(StorageEventOutboxService.name);
  private readonly recentEvents: StorageOutboxEvent[] = [];
  private readonly maxInMemoryHistory = 100;

  constructor(@Optional() private readonly redis?: RedisCacheService) {}

  @OnEvent('file.uploaded')
  async handleFileUploaded(event: FileUploadedEvent): Promise<void> {
    await this.dispatch('file.uploaded', {
      fileId: event.fileId,
      blobId: event.blobId,
      authorId: event.authorId,
      filename: event.filename,
      mimeType: event.mimeType,
      sizeBytes: event.sizeBytes.toString(),
      s3Key: event.s3Key,
      projectId: event.projectId ?? null,
    });
  }

  @OnEvent('file.downloaded')
  async handleFileDownloaded(event: FileDownloadedEvent): Promise<void> {
    await this.dispatch('file.downloaded', {
      fileId: event.fileId,
      filename: event.filename,
      mimeType: event.mimeType,
      sizeBytes: event.sizeBytes.toString(),
      accessedBy: event.accessedBy ?? null,
      clientIp: event.clientIp ?? null,
      projectId: event.projectId ?? null,
    });
  }

  @OnEvent('file.trashed')
  async handleFileTrashed(event: FileTrashedEvent): Promise<void> {
    await this.dispatch('file.trashed', {
      fileId: event.fileId,
      authorId: event.authorId,
      trashedAt: event.trashedAt ? event.trashedAt.toISOString() : new Date().toISOString(),
      projectId: event.projectId ?? null,
    });
  }

  @OnEvent('file.deleted')
  async handleFileDeleted(event: FileDeletedEvent): Promise<void> {
    await this.dispatch('file.deleted', {
      fileId: event.fileId,
      blobId: event.blobId,
      authorId: event.authorId,
      projectId: event.projectId ?? null,
      permanent: event.permanent,
    });
  }

  @OnEvent('quota.exceeded')
  async handleQuotaExceeded(event: QuotaExceededEvent): Promise<void> {
    await this.dispatch('quota.exceeded', {
      userId: event.userId,
      projectId: event.projectId ?? null,
      requestedBytes: event.requestedBytes.toString(),
      currentUsage: event.currentUsedBytes.toString(),
      maxQuota: event.maxBytes.toString(),
    });
  }

  public async dispatch(
    type: string,
    payload: Record<string, any>,
  ): Promise<StorageOutboxEvent> {
    const eventRecord: StorageOutboxEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };

    // 1. Maintain in-memory history for local queries & audit
    this.recentEvents.unshift(eventRecord);
    if (this.recentEvents.length > this.maxInMemoryHistory) {
      this.recentEvents.pop();
    }

    // 2. Publish to Redis Stream & PubSub channel if available
    const client = this.redis?.getClient();
    if (client && this.redis?.isReady()) {
      try {
        const serialized = JSON.stringify(eventRecord);
        // PubSub for real-time subscribers
        await client.publish('flux:storage:events', serialized);
        // Redis Stream for durable downstream event consumers (AI Agents / Workers)
        await client.xadd(
          'flux:storage:stream',
          'MAXLEN',
          '~',
          '10000',
          '*',
          'eventId',
          eventRecord.id,
          'type',
          type,
          'data',
          serialized,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to publish event ${type} to Redis: ${err?.message}`,
        );
      }
    }

    this.logger.debug(
      `Dispatched storage event [${type}]: ${eventRecord.id}`,
    );
    return eventRecord;
  }

  getRecentEvents(limit = 20): StorageOutboxEvent[] {
    return this.recentEvents.slice(0, limit);
  }
}
