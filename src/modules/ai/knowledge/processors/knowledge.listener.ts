import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { getErrorMessage } from '@/core';
import type {
  FileTrashedEvent,
  FileUploadedEvent,
} from '@/modules/experiments';
import {
  isAiKnowledgeEnabled,
  isIngestibleDocument,
} from '../domain/ingest.policy';
import { KnowledgeIngestService } from '../services/ingest.service';
import { KnowledgeQueueProducer } from './knowledge.producer';

@Injectable()
export class KnowledgeEventListener {
  private readonly logger = new Logger(KnowledgeEventListener.name);

  constructor(
    private readonly ingestService: KnowledgeIngestService,
    @Optional() private readonly producer?: KnowledgeQueueProducer,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  private isEnabled(): boolean {
    if (!this.configService) return true;
    return isAiKnowledgeEnabled({
      enabled: this.configService.get<string>('FLUX_AI_ENABLED'),
      url: this.configService.get<string>('FLUX_AI_URL'),
      nodeEnv: this.configService.get<string>('NODE_ENV'),
    });
  }

  @OnEvent('file.uploaded', { async: true })
  async handleFileUploaded(event: FileUploadedEvent): Promise<void> {
    if (
      this.configService?.get<string>('FLUX_AI_EAGER_INGEST_ON_UPLOAD') !==
      'true'
    ) {
      return;
    }
    if (!isIngestibleDocument(event.filename, event.mimeType)) {
      return;
    }
    if (!this.isEnabled()) {
      return;
    }

    const jobData = {
      fileId: event.fileId,
      authorId: event.authorId,
      filename: event.filename,
      mimeType: event.mimeType,
      projectId: event.projectId ?? null,
    };

    try {
      const enqueued = await this.producer?.enqueueIngest(jobData);
      if (!enqueued) {
        await this.ingestService.ingestStorageFile(jobData);
      }
    } catch (err: unknown) {
      this.logger.error(
        `Failed dispatching AI knowledge ingest for ${event.fileId}: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent('file.trashed', { async: true })
  async handleFileTrashed(event: FileTrashedEvent): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const payload = {
      fileId: event.fileId,
      authorId: event.authorId,
      projectId: event.projectId ?? null,
    };

    try {
      const enqueued = await this.producer?.enqueueDelete(payload);
      if (!enqueued) {
        await this.ingestService.removeStorageFileKnowledge(payload);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed dispatching AI knowledge delete for ${event.fileId}: ${getErrorMessage(err)}`,
      );
    }
  }
}
