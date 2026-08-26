import { FormattedCitation } from '../../cite/formatters/csl.formatter';
import { PdfAnnotation } from '../../annotations/types/annotations.types';
import { RelatedItem } from '../../relations/types/relations.types';

export interface ItemContext {
  item: any;
  citationApa: FormattedCitation;
  citationIeee: FormattedCitation;
  annotations: PdfAnnotation[];
  totalAnnotations: number;
  relatedItems: RelatedItem[];
  totalRelatedItems: number;
}

export type ResearchContext = ItemContext;
