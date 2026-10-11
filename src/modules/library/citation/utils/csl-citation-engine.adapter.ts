import { Injectable, Logger } from '@nestjs/common';
import {
  ICitationEnginePort,
  FormattedCitationResult,
  CitationStyleVo,
} from '../types/citation.types';
import { CitationService } from '../services/citation.service';

/**
 * Infrastructure Adapter implementing ICitationEnginePort using CitationService (CSL Engine).
 */
@Injectable()
export class CslCitationEngineAdapter implements ICitationEnginePort {
  private readonly logger = new Logger(CslCitationEngineAdapter.name);

  constructor(private readonly citationService: CitationService) {}

  async formatItem(
    userId: string,
    itemId: string,
    style: CitationStyleVo,
  ): Promise<FormattedCitationResult | null> {
    const res = await this.citationService.formatItemById(
      userId,
      itemId,
      style.value,
    );

    if (!res) return null;

    const resObj = res as {
      bibliography?: string;
      citation?: string;
      formatted?: string;
    };
    const formattedText =
      typeof res === 'string'
        ? res
        : resObj.bibliography || resObj.citation || resObj.formatted || '';

    return {
      formattedText,
      style: style.value,
      itemId,
    };
  }

  async formatBatch(
    userId: string,
    itemIds: string[],
    style: CitationStyleVo,
  ): Promise<FormattedCitationResult[]> {
    const res = await this.citationService.formatItemBatch(
      userId,
      itemIds,
      style.value,
    );

    if (!res || !Array.isArray(res)) return [];

    return res.map((r: unknown, idx: number) => {
      const itemRes = r as {
        bibliography?: string;
        citation?: string;
        formatted?: string;
      };
      const formattedText =
        typeof r === 'string'
          ? r
          : itemRes?.bibliography ||
            itemRes?.citation ||
            itemRes?.formatted ||
            '';

      return {
        formattedText,
        style: style.value,
        itemId: itemIds[idx] || '',
      };
    });
  }
}
