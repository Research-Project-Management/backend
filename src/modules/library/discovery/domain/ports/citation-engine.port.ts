import { CitationStyleVo } from '../value-objects/citation-style.vo';

export const CITATION_ENGINE_PORT = Symbol('CITATION_ENGINE_PORT');

export interface FormattedCitationResult {
  formattedText: string;
  style: string;
  itemId: string;
}

export interface ICitationEnginePort {
  formatItem(
    userId: string,
    itemId: string,
    style: CitationStyleVo,
  ): Promise<FormattedCitationResult | null>;
  formatBatch(
    userId: string,
    itemIds: string[],
    style: CitationStyleVo,
  ): Promise<FormattedCitationResult[]>;
}
