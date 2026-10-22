import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import zlib from 'zlib';
import { promisify } from 'util';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { DocumentFulltextResponse } from '@/modules/library/catalog/dto/items.dto';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';

const gunzipAsync = promisify(zlib.gunzip);

/**
 * ItemFulltextService — Dedicated Domain Service for Academic Document Intelligence.
 * Extracts, parses, and caches the structured academic full-text document tree (sections, figures, tables, formulas).
 * Feeds the Frontend Reader's DocumentNavDrawer and Outline.
 */
@Injectable()
export class ItemFulltextService {
  private readonly logger = new Logger(ItemFulltextService.name);

  constructor(
    private readonly query: QueryRepository,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  /**
   * Retrieves the structured academic full-text document tree extracted by native PDF extraction pipelines.
   */
  async getFulltext(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<DocumentFulltextResponse> {
    const cacheKey = LIBRARY_REDIS_KEYS.itemFulltext(id);
    if (this.cache) {
      try {
        const cached = await this.cache.get<
          DocumentFulltextResponse & {
            userId?: string;
            projectId?: string | null;
          }
        >(cacheKey);
        if (cached) {
          if (cached.userId) {
            const isOwner = cached.userId === userId;
            const isProjectMatch = Boolean(
              projectId && cached.projectId === projectId,
            );
            if (isOwner || isProjectMatch) {
              return cached;
            }
            this.logger.warn(
              `Unauthorized fulltext cache access attempt for item ${id} by user ${userId}`,
            );
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cache lookup error for ${cacheKey}: ${message}`);
      }
    }

    const item = await this.query.findById(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found or access denied`);
    }

    // 1. Look for authoritative full-text or header extraction record in a single query via QueryRepository
    const matchedRecord = await this.query.findItemMetadataByProviders(id, [
      'pdf_fulltext',
      'trusted_extraction',
      'ocr',
      'mextract_fulltext',
      'mextract',
    ]);

    const isFulltextProvider =
      matchedRecord && matchedRecord.sourceProvider !== 'mextract';

    let result: DocumentFulltextResponse;
    if (
      isFulltextProvider &&
      matchedRecord?.rawPayload &&
      typeof matchedRecord.rawPayload === 'object'
    ) {
      let payload = matchedRecord.rawPayload as Record<string, unknown>;

      if (
        payload.isOffloaded === true &&
        typeof payload.fileId === 'string' &&
        this.storagePort
      ) {
        try {
          const rawDownloaded = await this.storagePort.readOwnedFile({
            fileId: payload.fileId,
            userId: item.userId,
            projectId: item.projectId ?? undefined,
          });

          const compressedBuffer = Buffer.isBuffer(rawDownloaded)
            ? rawDownloaded
            : rawDownloaded &&
                typeof rawDownloaded === 'object' &&
                'buffer' in rawDownloaded &&
                Buffer.isBuffer((rawDownloaded as { buffer?: unknown }).buffer)
              ? (rawDownloaded as { buffer: Buffer }).buffer
              : null;

          if (compressedBuffer) {
            const decompressed = await gunzipAsync(compressedBuffer);
            const hydrated = JSON.parse(
              decompressed.toString('utf8'),
            ) as Record<string, unknown>;
            payload = {
              ...payload,
              ...hydrated,
            };
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to download/decompress offloaded fulltext for item ${id} (fileId=${payload.fileId}), falling back to inline fields: ${message}`,
          );
        }
      }

      result = {
        title:
          (typeof payload.title === 'string' ? payload.title : undefined) ||
          item.title,
        abstract:
          (typeof payload.abstract === 'string'
            ? payload.abstract
            : undefined) ||
          item.abstract ||
          undefined,
        sections: (Array.isArray(payload.sections)
          ? payload.sections
          : []) as DocumentFulltextResponse['sections'],
        figures: (Array.isArray(payload.figures)
          ? payload.figures
          : []) as DocumentFulltextResponse['figures'],
        tables: (Array.isArray(payload.tables)
          ? payload.tables
          : []) as DocumentFulltextResponse['tables'],
        formulas: (Array.isArray(payload.formulas)
          ? payload.formulas
          : []) as DocumentFulltextResponse['formulas'],
        references: (Array.isArray(payload.references)
          ? payload.references
          : []) as DocumentFulltextResponse['references'],
        ...(typeof payload.markdown === 'string'
          ? { markdown: payload.markdown }
          : {}),
        ...(typeof payload.plainText === 'string'
          ? { plainText: payload.plainText }
          : {}),
        ...(typeof payload.pageCount === 'number'
          ? { pageCount: payload.pageCount }
          : {}),
      };
    } else if (
      matchedRecord?.rawPayload &&
      typeof matchedRecord.rawPayload === 'object'
    ) {
      // 2. Fallback to header/metadata extraction record ('mextract') if available
      const payload = matchedRecord.rawPayload as Record<string, unknown>;
      result = {
        title:
          (typeof payload.title === 'string' ? payload.title : undefined) ||
          item.title,
        abstract:
          (typeof payload.abstract === 'string'
            ? payload.abstract
            : undefined) ||
          item.abstract ||
          undefined,
        sections: [],
        figures: [],
        tables: [],
        formulas: [],
        references: (Array.isArray(payload.references)
          ? payload.references
          : []) as DocumentFulltextResponse['references'],
      };
    } else {
      // 3. Return clean empty structure instead of 404 so Reader renders gracefully
      result = {
        title: item.title,
        abstract: item.abstract || undefined,
        sections: [],
        figures: [],
        tables: [],
        formulas: [],
        references: [],
      };
    }

    if (this.cache) {
      try {
        const cachedPayload = {
          ...result,
          userId: item.userId,
          projectId: item.projectId ?? null,
        };
        await this.cache.set(cacheKey, cachedPayload, 600); // 10 min TTL
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cache set error for ${cacheKey}: ${message}`);
      }
    }

    return result;
  }
}
