import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { DocumentFulltextResponse } from '@/modules/library/catalog/dto/items.dto';

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

    // 1. Look for authoritative pdf_fulltext, trusted_extraction, or ocr record via QueryRepository
    const fulltextRecord =
      (await this.query.findMetadataSourceRecord(id, 'pdf_fulltext')) ||
      (await this.query.findMetadataSourceRecord(id, 'trusted_extraction')) ||
      (await this.query.findMetadataSourceRecord(id, 'ocr')) ||
      (await this.query.findMetadataSourceRecord(id, 'mextract_fulltext'));

    let result: DocumentFulltextResponse;
    if (
      fulltextRecord?.rawPayload &&
      typeof fulltextRecord.rawPayload === 'object'
    ) {
      const payload = fulltextRecord.rawPayload as Record<string, unknown>;
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
      };
    } else {
      // 2. Fallback to header/metadata extraction record if available
      const headerRecord = await this.query.findMetadataSourceRecord(
        id,
        'mextract',
      );

      if (
        headerRecord?.rawPayload &&
        typeof headerRecord.rawPayload === 'object'
      ) {
        const payload = headerRecord.rawPayload as Record<string, unknown>;
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
