import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisCacheService, RedisPubSubService } from '@/core';
import {
  FileDownloadedEvent,
  FileTrashedEvent,
  FileUploadedEvent,
} from '../domain/experiments.event';

export interface ExperimentOutboxEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class ExperimentsEventListener {
  private readonly logger = new Logger(ExperimentsEventListener.name);
  private readonly recentEvents: ExperimentOutboxEvent[] = [];
  private readonly maxInMemoryHistory = 100;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly pubSub?: RedisPubSubService,
  ) {}

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
      trashedAt: event.trashedAt
        ? event.trashedAt.toISOString()
        : new Date().toISOString(),
      projectId: event.projectId ?? null,
    });
  }

  public async dispatch(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<ExperimentOutboxEvent> {
    const eventRecord: ExperimentOutboxEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };

    this.recentEvents.unshift(eventRecord);
    if (this.recentEvents.length > this.maxInMemoryHistory) {
      this.recentEvents.pop();
    }

    const serialized = JSON.stringify(eventRecord);
    if (this.pubSub?.isReady()) {
      await this.pubSub.publish('flux:experiments:events', serialized);
    }

    const client = this.redis?.getClient();
    if (client && this.redis?.isReady()) {
      try {
        if (!this.pubSub?.isReady()) {
          await client.publish('flux:experiments:events', serialized);
        }
        await client.xadd(
          'flux:experiments:stream',
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
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to publish event ${type} to Redis: ${(err as Error)?.message}`,
        );
      }
    }

    this.logger.debug(
      `Dispatched experiment event [${type}]: ${eventRecord.id}`,
    );
    return eventRecord;
  }

  getRecentEvents(limit = 20): ExperimentOutboxEvent[] {
    return this.recentEvents.slice(0, limit);
  }
}
