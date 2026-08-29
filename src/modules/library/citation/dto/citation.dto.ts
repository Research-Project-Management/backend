import { CitationItemInput, CitationStyleId } from '../types/citation.types';

export class FormatCitationDto {
  item!: CitationItemInput;
  styleId?: CitationStyleId;
  index?: number;
}

export class FormatBatchCitationDto {
  items!: CitationItemInput[];
  styleId?: CitationStyleId;
}
