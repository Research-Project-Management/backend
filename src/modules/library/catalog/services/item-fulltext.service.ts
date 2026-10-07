import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { QueryRepository } from '../repositories/query.repository';
import { RedisCacheService } from '../../../../core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../../shared-kernel/core/constants/redis-keys.constants';
import { DocumentFulltextResponse } from '../dto/items.dto';

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
   * Retrieves the structured academic full-text document tree extracted by GROBID / PDF pipelines.
   */
  async getFulltext(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<DocumentFulltextResponse> {
    const cacheKey = LIBRARY_REDIS_KEYS.itemFulltext(id);
    if (this.cache) {
      try {
        const cached = await this.cache.get<any>(cacheKey);
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
          } else {
            // Backward compatibility for mocks/legacy entries without userId
            return cached;
          }
        }
      } catch (err: any) {
        this.logger.debug(
          `Cache lookup error for ${cacheKey}: ${err?.message || err}`,
        );
      }
    }

    const item = await this.query.findById(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found or access denied`);
    }

    // 1. Look for authoritative pdf_fulltext (or legacy grobid_fulltext) record via QueryRepository
    const fulltextRecord =
      (await this.query.findMetadataSourceRecord(id, 'pdf_fulltext')) ||
      (await this.query.findMetadataSourceRecord(id, 'grobid_fulltext'));

    let result: DocumentFulltextResponse;
    if (
      fulltextRecord?.rawPayload &&
      typeof fulltextRecord.rawPayload === 'object'
    ) {
      const payload = fulltextRecord.rawPayload as Record<string, any>;
      result = {
        title: payload.title || item.title,
        abstract: payload.abstract || item.abstract || undefined,
        sections: Array.isArray(payload.sections) ? payload.sections : [],
        figures: Array.isArray(payload.figures) ? payload.figures : [],
        tables: Array.isArray(payload.tables) ? payload.tables : [],
        formulas: Array.isArray(payload.formulas) ? payload.formulas : [],
        references: Array.isArray(payload.references) ? payload.references : [],
      };
    } else {
      // 2. Fallback to grobid header record if available via QueryRepository
      const headerRecord = await this.query.findMetadataSourceRecord(
        id,
        'grobid',
      );

      if (
        headerRecord?.rawPayload &&
        typeof headerRecord.rawPayload === 'object'
      ) {
        const payload = headerRecord.rawPayload as Record<string, any>;
        result = {
          title: payload.title || item.title,
          abstract: payload.abstract || item.abstract || undefined,
          sections: [],
          figures: [],
          tables: [],
          formulas: [],
          references: Array.isArray(payload.references)
            ? payload.references
            : [],
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
      } catch (err: any) {
        this.logger.debug(
          `Cache set error for ${cacheKey}: ${err?.message || err}`,
        );
      }
    }

    return result;
  }
}
