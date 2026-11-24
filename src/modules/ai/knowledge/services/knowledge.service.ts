import { Inject, Injectable, Logger } from '@nestjs/common';
import { getErrorMessage } from '@/core';
import { AI_ENGINE_PORT } from '../../ai.constant';
import { AccessService } from '../../access/services/access.service';
import type { IAiEnginePort } from '../../engine/engine.port';
import {
  mapStorageFileToKnowledgeItem,
  readMetadataRecord,
} from '../domain/knowledge.mapper';
import { KnowledgeRepository } from '../knowledge.repository';
import type { KnowledgeDocumentItem } from '../types/knowledge.type';

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly repo: KnowledgeRepository,
    @Inject(AI_ENGINE_PORT)
    private readonly engine: IAiEnginePort,
    private readonly accessService: AccessService,
  ) {}

  async getDocuments(
    userId: string,
    rawSpaceId?: string,
  ): Promise<KnowledgeDocumentItem[]> {
    const scope = await this.accessService.resolveSpace(userId, rawSpaceId);
    const files = await this.repo.listSpaceFiles(scope.spaceId);

    return files
      .filter((file) => {
        const meta = readMetadataRecord(file.metadata);
        return (
          meta.ragStatus === 'indexed' || typeof meta.ragDocId === 'string'
        );
      })
      .map(mapStorageFileToKnowledgeItem);
  }

  async getDocumentsBulk(
    userId: string,
    ids: string[],
    rawSpaceId?: string,
  ): Promise<KnowledgeDocumentItem[]> {
    if (!ids.length) return [];
    const scope = await this.accessService.resolveSpace(userId, rawSpaceId);
    const files = await this.repo.findFilesBulk(ids, scope.spaceId);
    return files.map(mapStorageFileToKnowledgeItem);
  }

  async getDocumentContent(
    userId: string,
    docId: string,
    rawSpaceId?: string,
  ): Promise<{ id: string; text: string; content: string; title?: string }> {
    const scope = await this.accessService.resolveSpace(userId, rawSpaceId);
    const file = await this.repo.findOwnedFileByDocId(docId, scope.spaceId);
    const meta = readMetadataRecord(file?.metadata);
    const sourceId =
      typeof meta.ragDocId === 'string' && meta.ragDocId.trim()
        ? meta.ragDocId
        : docId;

    const hits = await this.engine
      .searchKnowledge({
        space_id: scope.spaceId,
        query:
          (typeof meta.title === 'string' && meta.title) ||
          file?.filename ||
          sourceId,
        limit: 20,
        source_ids: [sourceId],
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Knowledge content lookup failed for ${docId}: ${getErrorMessage(err)}`,
        );
        return [];
      });

    const text =
      hits.map((h) => h.content).join('\n\n') ||
      (typeof meta.abstract === 'string' ? meta.abstract : '');

    return {
      id: sourceId,
      title: typeof meta.title === 'string' ? meta.title : file?.filename,
      text,
      content: text,
    };
  }

  async deleteDocument(
    userId: string,
    docId: string,
    rawSpaceId?: string,
  ): Promise<{ deleted: boolean; id: string }> {
    const scope = await this.accessService.resolveSpace(userId, rawSpaceId);
    const file = await this.repo.findOwnedFileByDocId(docId, scope.spaceId);
    const meta = readMetadataRecord(file?.metadata);
    const targetId =
      typeof meta.ragDocId === 'string' && meta.ragDocId.trim()
        ? meta.ragDocId
        : docId;

    const sourceType = file ? 'file' : 'upload';
    await this.engine
      .deleteKnowledgeSource(scope.spaceId, sourceType, targetId)
      .catch((err: unknown) => {
        this.logger.warn(
          `Vector delete failed for ${docId}: ${getErrorMessage(err)}`,
        );
      });

    if (file) {
      const nextMeta = { ...meta };
      delete nextMeta.ragStatus;
      delete nextMeta.ragDocId;
      delete nextMeta.ragIndexedAt;
      delete nextMeta.ragError;
      await this.repo.updateFileMetadata(file.id, nextMeta).catch(() => {});
    }

    return { deleted: true, id: docId };
  }
}
