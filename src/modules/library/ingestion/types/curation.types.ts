import { ITEM_COLUMN_METADATA_FIELDS } from '@/modules/library/core/types/bibliographic.types';
import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';

export const ALLOWED_MERGE_METADATA_FIELDS = new Set([
  ...ITEM_COLUMN_METADATA_FIELDS,
  ...SCHEMA_V42_DATA.distinctFieldKeys,
  'authors',
  'creators',
  'contributors',
  'editors',
  'extra',
  'extraFields',
  'tags',
  'identifiers',
]);

export interface DuplicateClusterItem {
  id: string;
  title: string;
  itemType?: string;
  type?: string;
  doi?: string;
  isbn?: string | null;
  issn?: string | null;
  pmid?: string | null;
  arxivId?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  abstract?: string | null;
  abstractNote?: string | null;
  url?: string | null;
  authors?: string[];
  creators?: unknown[];
  citationKey?: string;
  collectionId?: string | null;
  collections?: unknown[];
  tags?: unknown[];
  attachments?: unknown[];
  notes?: unknown[];
  extra?: string | null;
  extraFields?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export class DuplicateClusterResult {
  clusterId!: string;
  matchReason!: 'EXACT_DOI' | 'FUZZY_TITLE_YEAR_AUTHOR' | (string & {});
  confidence!: number;
  recommendedMasterId?: string;
  items!: DuplicateClusterItem[];
  papers?: DuplicateClusterItem[];
}

export interface PrismaMergeAuditTrail {
  masterItemId: string;
  mergedDuplicateIds: string[];
  matchReasons: string[];
  preservedCitationKeys: string[];
  consolidatedAttachments: number;
  consolidatedNotes: number;
  consolidatedTags: number;
  consolidatedCollections: number;
  backfilledFields: string[];
  timestamp: string;
}

export interface QualityAuditItemResult {
  id: string;
  title: string;
  score: number;
  missingFields: string[];
}
