import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { getErrorMessage } from '@/core';
import { EXPERIMENTS_PORT, type IExperimentsPort } from '@/modules/experiments';
import { LIBRARY_FACADE, type ILibraryFacade } from '@/modules/library';
import { AI_ENGINE_PORT } from '../../ai.constant';
import { AccessService } from '../../access/services/access.service';
import type { IAiEnginePort } from '../../engine/engine.port';
import { readMetadataRecord } from '../domain/knowledge.mapper';
import { KnowledgeRepository } from '../knowledge.repository';
import type {
  KnowledgeFileJobData,
  KnowledgeUploadOptions,
  KnowledgeUploadResult,
} from '../types/knowledge.type';

@Injectable()
export class KnowledgeIngestService {
  private readonly logger = new Logger(KnowledgeIngestService.name);

  constructor(
    private readonly repo: KnowledgeRepository,
    @Inject(AI_ENGINE_PORT)
    private readonly engine: IAiEnginePort,
    private readonly accessService: AccessService,
    @Optional()
    @Inject(EXPERIMENTS_PORT)
    private readonly experimentsPort?: IExperimentsPort,
    @Optional()
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade?: ILibraryFacade,
  ) {}

  async ingestStorageFile(
    data: KnowledgeFileJobData,
    options?: { rethrowOnFailure?: boolean },
  ): Promise<void> {
    const file = await this.repo.findFileById(data.fileId);
    if (!file || file.deletedAt) {
      this.logger.warn(
        `StorageFile ${data.fileId} not found or deleted. Skipping ingest.`,
      );
      return;
    }

    const currentMeta = readMetadataRecord(file.metadata);
    const existingRagDocId =
      typeof currentMeta.ragDocId === 'string' ? currentMeta.ragDocId : '';
    if (currentMeta.ragStatus === 'indexed' && existingRagDocId) {
      this.logger.debug(
        `File ${data.fileId} already indexed (ragDocId=${existingRagDocId}).`,
      );
      return;
    }

    if (!this.experimentsPort) {
      throw new Error('ExperimentsPort is not available to read file bytes');
    }

    await this.repo.updateFileMetadata(data.fileId, {
      ...currentMeta,
      ragStatus: 'processing',
      ragStartedAt: new Date().toISOString(),
    });

    try {
      const storageFile = await this.experimentsPort.readOwnedFile({
        fileId: data.fileId,
        userId: data.authorId,
        projectId: data.projectId ?? undefined,
      });

      if (!storageFile.buffer || storageFile.buffer.length === 0) {
        throw new Error(`Empty buffer for file ${data.fileId}`);
      }

      const bibMeta = await this.extractOptionalBibMetadata(
        storageFile.buffer,
        data.filename,
        data.mimeType,
      );

      const spaceId = file.spaceId || data.projectId || data.authorId;
      let ragDocId: string | null = null;
      let chunkCount = 0;
      let pageCount = bibMeta.pageCount;
      let ragError: string | undefined;

      try {
        const ingested = await this.engine.ingestDocument({
          spaceId,
          sourceType: 'file',
          sourceId: data.fileId,
          fileBuffer: storageFile.buffer,
          filename: data.filename,
          mimeType: data.mimeType,
          title: bibMeta.title,
          metadata: {
            authors: bibMeta.authors,
            doi: bibMeta.doi,
            arxivId: bibMeta.arxivId,
            year: bibMeta.year,
            abstract: bibMeta.abstract,
          },
        });
        ragDocId = ingested.source_id || data.fileId;
        chunkCount = ingested.chunks_indexed;
        pageCount = ingested.pages_parsed || pageCount;
      } catch (engineErr: unknown) {
        ragError = getErrorMessage(engineErr);
        this.logger.warn(
          `AI ingest failed for file ${data.fileId}: ${ragError}`,
        );
      }

      const isIndexed = Boolean(ragDocId);
      await this.repo.updateFileMetadata(data.fileId, {
        ...currentMeta,
        ragDocId: ragDocId || undefined,
        ragStatus: isIndexed ? 'indexed' : 'failed',
        ragIndexedAt: isIndexed ? new Date().toISOString() : undefined,
        ragError: isIndexed ? undefined : ragError || 'AI engine unavailable',
        title: bibMeta.title,
        authors: bibMeta.authors,
        doi: bibMeta.doi,
        arxivId: bibMeta.arxivId,
        year: bibMeta.year,
        abstract: bibMeta.abstract,
        chunkCount,
        pageCount,
      });

      if (!isIndexed && options?.rethrowOnFailure) {
        throw new Error(ragError || 'AI engine unavailable');
      }

      if (isIndexed && ragDocId) {
        await this.propagateToLibrary(
          data.fileId,
          ragDocId,
          data.authorId,
          data.projectId ?? undefined,
        );
      }
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      this.logger.error(
        `AI knowledge ingest failed for file ${data.fileId}: ${errorMessage}`,
      );
      await this.repo.updateFileMetadata(data.fileId, {
        ...currentMeta,
        ragStatus: 'failed',
        ragError: errorMessage,
      });
      throw err;
    }
  }

  async ingestUploadedBuffer(
    userId: string,
    fileBuffer: Buffer,
    mimeType: string,
    filename: string,
    options?: KnowledgeUploadOptions,
  ): Promise<KnowledgeUploadResult> {
    const scope = await this.accessService.resolveSpace(
      userId,
      options?.spaceId,
    );
    await this.accessService.verifyChatOwnership(userId, options?.chatId);

    const sourceId = crypto.randomUUID();
    const res = await this.engine.ingestDocument({
      spaceId: scope.spaceId,
      sourceType: 'upload',
      sourceId,
      fileBuffer,
      filename,
      mimeType,
      title: options?.title || filename,
      metadata: {
        user_id: userId,
        ...(options?.chatId ? { chat_id: options.chatId } : {}),
        ...(options?.tags ? { tags: options.tags } : {}),
      },
    });

    return {
      id: res.source_id,
      docId: res.source_id,
      name: filename,
      title: res.title || options?.title || filename,
      size: fileBuffer.length,
      chunk_count: res.chunks_indexed,
      pages_parsed: res.pages_parsed,
      status: 'indexed',
      space_id: res.space_id,
    };
  }

  async removeStorageFileKnowledge(params: {
    fileId: string;
    authorId: string;
    projectId?: string | null;
  }): Promise<void> {
    const file = await this.repo.findFileById(params.fileId);
    const meta = readMetadataRecord(file?.metadata);
    const spaceId = file?.spaceId || params.projectId || params.authorId;
    const sourceId =
      typeof meta.ragDocId === 'string' && meta.ragDocId.trim()
        ? meta.ragDocId
        : params.fileId;

    await this.engine
      .deleteKnowledgeSource(spaceId, 'file', sourceId)
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed deleting AI knowledge for file ${params.fileId}: ${getErrorMessage(err)}`,
        );
      });
  }

  private async extractOptionalBibMetadata(
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<{
    title: string;
    authors?: string[];
    doi?: string;
    arxivId?: string;
    year?: number;
    abstract?: string;
    pageCount: number;
  }> {
    const fallbackTitle = filename || 'Untitled';
    const isPdf =
      mimeType.toLowerCase().includes('pdf') ||
      filename.toLowerCase().endsWith('.pdf');
    if (!isPdf || !this.libraryFacade?.extractDocumentFromBuffer) {
      return { title: fallbackTitle, pageCount: 0 };
    }

    try {
      const extracted = await this.libraryFacade.extractDocumentFromBuffer(
        buffer,
        { maxPages: 2, headerOnly: true },
      );
      return {
        title: extracted.metadata?.title || fallbackTitle,
        authors: extracted.metadata?.authors,
        doi: extracted.metadata?.doi,
        arxivId: extracted.metadata?.arxivId,
        year: extracted.metadata?.year,
        abstract: extracted.metadata?.abstract,
        pageCount: Array.isArray(extracted.pages) ? extracted.pages.length : 0,
      };
    } catch {
      return { title: fallbackTitle, pageCount: 0 };
    }
  }

  private async propagateToLibrary(
    fileId: string,
    ragDocId: string,
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.libraryFacade) return;
    try {
      const scope = { userId, projectId };
      const attachment = await this.libraryFacade.findAttachmentByFileId(
        fileId,
        scope,
      );
      if (!attachment) return;

      await this.libraryFacade.updateAttachmentProcessingStatus(
        attachment.id,
        'indexed',
        { ragDocId, ragStatus: 'indexed' },
        scope,
      );
      if (attachment.itemId) {
        await this.libraryFacade.updateItemAiMetadata(
          attachment.itemId,
          { ragDocId, ragStatus: 'indexed' },
          scope,
        );
      }
    } catch (err: unknown) {
      this.logger.debug(
        `Non-fatal library propagation skipped for ${fileId}: ${getErrorMessage(err)}`,
      );
    }
  }
}
