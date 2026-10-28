import { Prisma } from '@prisma/client';
import type { TransactionHelpers } from '../ports/unit-of-work.port';

export interface QualityAuditCandidateItem {
  id: string;
  title: string;
  doi: string | null;
  abstract: string | null;
  year: number | null;
  contributors: Array<{ id: string }>;
  publicationTitle: string | null;
}

export interface DuplicateCandidateItem {
  id: string;
  title: string;
  itemType?: string | null;
  type?: string | null;
  doi: string | null;
  arxivId?: string | null;
  isbn: string | null;
  issn: string | null;
  pmid: string | null;
  citationKey: string | null;
  year: number | null;
  metadata?: Record<string, unknown> | null;
  contributors: Array<{
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    orderIndex: number;
  }>;
}

export interface NoteEntity {
  id: string;
  projectId?: string | null;
  itemId?: string | null;
  title: string;
  contentJson?: unknown;
  contentMd?: string | null;
  tags?: string[];
  createdById?: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateNoteData {
  projectId?: string;
  itemId?: string | null;
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  createdById?: string;
}

export interface ItemTypeConversionFieldDiff {
  key: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  status: 'preserved' | 'mapped' | 'cleared';
  baseSemantic?: string;
}

export interface ItemTypeConversionRoleDiff {
  creatorId?: string;
  name: string;
  sourceRole: string;
  targetRole: string;
  changed: boolean;
}

export interface FieldMappingChange {
  fromField: string;
  toField: string;
  value: unknown;
  rule: 'direct' | 'base-semantic' | 'special-rule';
}

export interface DroppedField {
  field: string;
  label: string;
  value: unknown;
}

export interface CreatorRoleChange {
  creator: Record<string, unknown>;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'primary-fallback' | 'secondary-fallback';
}

export interface TypeConversionPreview {
  sourceType: string;
  targetType: string;
  preservedFields: string[];
  mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[];
  newAvailableFields: string[];
  schemaUnsupportedFields?: string[];
  schemaUnsupportedFieldLabels?: string[];
  creatorChanges: CreatorRoleChange[];
  projectedItem: Record<string, unknown>;
  unmappedRetained: Record<string, unknown>;
  hasLoss: boolean;
}

export interface ConvertTypeOptions {
  expectedVersion?: number;
  retainUnmappedInExtra?: boolean;
}

export const ITEM_TRANSFORMER_PORT = Symbol('ITEM_TRANSFORMER_PORT');

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext<TTx = Prisma.TransactionClient> {
  tx: TTx;
  helpers: TransactionHelpers;
}
