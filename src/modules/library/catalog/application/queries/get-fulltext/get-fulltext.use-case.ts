import {
  Injectable,
  Inject,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { QueryRepository } from '../../../infrastructure/repositories/query.repository';
import { DocumentFulltextResponse } from '../../dtos/items.dto';

export interface GetFulltextQuery {
  userId: string;
  itemId: string;
  projectId?: string;
}

/**
 * Query Use Case — Get Fulltext Document Structure
 *
 * Retrieves the GROBID-parsed fulltext structure of a library item's PDF:
 * sections, figures, tables, formulas, and references.
 * Feeds the Frontend Reader's DocumentNavDrawer.
 *
 * Application layer: depends only on QueryRepository (infrastructure-facing but
 * stable read-model). Does NOT import Prisma or NestJS HTTP concerns.
 */
@Injectable()
export class GetFulltextUseCase {
  constructor(private readonly queryRepo: QueryRepository) {}

  async execute(query: GetFulltextQuery): Promise<DocumentFulltextResponse> {
    const item = await this.queryRepo.findById(
      query.userId,
      query.itemId,
      query.projectId,
    );
    if (!item) {
      throw new NotFoundException(
        `Item ${query.itemId} not found or access denied`,
      );
    }

    // 1. Try authoritative grobid_fulltext record
    const fulltextRecord = await this.queryRepo.findMetadataSourceRecord(
      query.itemId,
      'grobid_fulltext',
    );

    if (
      fulltextRecord?.rawPayload &&
      typeof fulltextRecord.rawPayload === 'object'
    ) {
      const payload = fulltextRecord.rawPayload as Record<string, any>;
      return {
        title: payload.title || item.title,
        abstract: payload.abstract || item.abstract || undefined,
        sections: Array.isArray(payload.sections) ? payload.sections : [],
        figures: Array.isArray(payload.figures) ? payload.figures : [],
        tables: Array.isArray(payload.tables) ? payload.tables : [],
        formulas: Array.isArray(payload.formulas) ? payload.formulas : [],
        references: Array.isArray(payload.references) ? payload.references : [],
      };
    }

    // 2. Fallback to grobid header record
    const headerRecord = await this.queryRepo.findMetadataSourceRecord(
      query.itemId,
      'grobid',
    );

    if (
      headerRecord?.rawPayload &&
      typeof headerRecord.rawPayload === 'object'
    ) {
      const payload = headerRecord.rawPayload as Record<string, any>;
      return {
        title: payload.title || item.title,
        abstract: payload.abstract || item.abstract || undefined,
        sections: [],
        figures: [],
        tables: [],
        formulas: [],
        references: Array.isArray(payload.references) ? payload.references : [],
      };
    }

    // 3. Return empty structure — Reader renders gracefully
    return {
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
