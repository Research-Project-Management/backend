import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  CITATION_ENGINE_PORT,
  ICitationEnginePort,
  FormattedCitationResult,
} from '../../domain/ports/citation-engine.port';
import { CitationStyleVo } from '../../domain/value-objects/citation-style.vo';

export interface FormatCitationQuery {
  userId: string;
  itemId: string;
  style?: string;
}

@Injectable()
export class FormatCitationUseCase {
  private readonly logger = new Logger(FormatCitationUseCase.name);

  constructor(
    @Inject(CITATION_ENGINE_PORT)
    private readonly citationEngine: ICitationEnginePort,
  ) {}

  async execute(
    query: FormatCitationQuery,
  ): Promise<FormattedCitationResult | null> {
    const styleVo = CitationStyleVo.create(query.style);
    return this.citationEngine.formatItem(query.userId, query.itemId, styleVo);
  }
}
