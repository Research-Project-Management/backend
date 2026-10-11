import { ITEM_COLUMN_METADATA_FIELDS } from '../../shared-kernel/types/bibliographic.types';
import rawZoteroSchema from '../../shared-kernel/data/zotero-schema.json';

interface ZoteroTypeWithFields {
  fields?: Array<{ field?: string }>;
}

// Build complete set of all valid schema fields across all 37 Zotero item types
const ALL_ZOTERO_SCHEMA_FIELDS: string[] = [];
const rawItemTypes = (rawZoteroSchema as { itemTypes?: unknown })?.itemTypes;
if (rawItemTypes && typeof rawItemTypes === 'object') {
  const itemTypeList = Array.isArray(rawItemTypes)
    ? rawItemTypes
    : Object.values(rawItemTypes);
  for (const itemTypeDef of itemTypeList as ZoteroTypeWithFields[]) {
    if (Array.isArray(itemTypeDef?.fields)) {
      for (const fieldDef of itemTypeDef.fields) {
        if (fieldDef?.field) ALL_ZOTERO_SCHEMA_FIELDS.push(fieldDef.field);
      }
    }
  }
}

export const ALLOWED_MERGE_METADATA_FIELDS = new Set([
  ...ITEM_COLUMN_METADATA_FIELDS,
  ...ALL_ZOTERO_SCHEMA_FIELDS,
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
