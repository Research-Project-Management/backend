import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import {
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  PRISMA_ITEM_SCALAR_COLUMNS,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
} from '@/modules/library/core/types/bibliographic.types';

export {
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  PRISMA_ITEM_SCALAR_COLUMNS,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
};

export const ITEM_COLUMN_METADATA_FIELDS = new Set<string>(
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
);

export {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
} from '@/modules/library/core/types/schema.constants';

export const TYPE_SPECIFIC_EXTRA_FIELDS = [
  ...new Set(
    Object.values(SCHEMA_V42_DATA.itemTypes)
      .flatMap((itemType) => itemType.fields.map((field) => field.key))
      .filter((field) => !ITEM_COLUMN_METADATA_FIELDS.has(field)),
  ),
];

export function parseAccessDate(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export type {
  CreateItemData,
  UpdateItemData,
} from '@/modules/library/core/types/bibliographic.types';
