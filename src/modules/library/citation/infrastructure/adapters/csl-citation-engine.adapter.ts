import { Injectable, Logger } from '@nestjs/common';
import {
  ICitationEnginePort,
  FormattedCitationResult,
} from '../../domain/ports/citation-engine.port';
import { CitationStyleVo } from '../../domain/value-objects/citation-style.vo';
import { CitationService } from '../../application/services/citation.service';

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
      style.value as any,
    );

    if (!res) return null;

    return {
      formattedText:
        typeof res === 'string'
          ? res
          : (res as any).citation || (res as any).formatted || '',
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
      style.value as any,
    );

    if (!res || !Array.isArray(res)) return [];

    return res.map((r: any, idx: number) => ({
      formattedText: typeof r === 'string' ? r : r?.citation || '',
      style: style.value,
      itemId: itemIds[idx] || '',
    }));
  }
}
