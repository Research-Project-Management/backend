import { ITEM_COLUMN_METADATA_FIELDS } from '../../items/constants/items.constants';

export const ALLOWED_MERGE_METADATA_FIELDS = new Set([
  ...ITEM_COLUMN_METADATA_FIELDS,
  'authors',
  'creators',
  'editors',
]);

export interface DuplicateClusterItem {
  id: string;
  title: string;
  doi?: string;
  year?: number | null;
  authors?: string[];
  citationKey?: string;
  collectionId?: string | null;
}

export class DuplicateClusterResult {
  clusterId!: string;
  matchReason!: 'EXACT_DOI' | 'FUZZY_TITLE_YEAR_AUTHOR' | (string & {});
  confidence!: number;
  items!: DuplicateClusterItem[];
}

export interface QualityAuditItemResult {
  id: string;
  title: string;
  score: number;
  missingFields: string[];
}
