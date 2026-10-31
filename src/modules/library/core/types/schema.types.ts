import type { Prisma } from '@prisma/client';
import type { TransactionHelpers } from '../ports';

/**
 * Canonical Branded ID & Nominal Types for Flux Library.
 * Implements Matt Pocock's Total TypeScript Nominal Branding Pattern.
 * Prevents accidental cross-assignment of UUIDs across distinct entity domains.
 */
declare const _brand: unique symbol;

/**
 * Nominal Branding Utility.
 * Attaches a compile-time unique brand tag to a base type with zero runtime cost.
 */
export type Brand<T, TBrand extends string> = T & { readonly [_brand]: TBrand };

export type ItemId = Brand<string, 'ItemId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type TagId = Brand<string, 'TagId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProjectId = Brand<string, 'ProjectId'>;

/**
 * Core Item-Type Schema & Registry Types for Flux Library.
 * Defines the canonical bibliographic item-type registry owned by the Library domain.
 */

/**
 * All 38 authoritative Zotero/CSL Item Types.
 * Matt Pocock Discriminated Union pattern for canonical bibliographic items.
 */
export type CanonicalItemType =
  | 'journalArticle'
  | 'preprint'
  | 'conferencePaper'
  | 'thesis'
  | 'report'
  | 'dataset'
  | 'presentation'
  | 'standard'
  | 'book'
  | 'bookSection'
  | 'manuscript'
  | 'dictionaryEntry'
  | 'encyclopediaArticle'
  | 'magazineArticle'
  | 'newspaperArticle'
  | 'bill'
  | 'case'
  | 'hearing'
  | 'statute'
  | 'patent'
  | 'audioRecording'
  | 'videoRecording'
  | 'film'
  | 'radioBroadcast'
  | 'tvBroadcast'
  | 'podcast'
  | 'artwork'
  | 'map'
  | 'blogPost'
  | 'webpage'
  | 'forumPost'
  | 'letter'
  | 'interview'
  | 'document'
  | 'email'
  | 'instantMessage'
  | 'computerProgram'
  | 'annotation'
  | 'attachment'
  | 'note';

export interface ItemFieldDefinition {
  key: string;
  field?: string;
  label: string;
  baseField?: string;
  order?: number;
  category?:
    'core' | 'venue' | 'publication' | 'identifiers' | 'archive' | 'extra';
  type?: 'text' | 'textarea' | 'date' | 'number' | 'url';
  placeholder?: string;
  mono?: boolean;
}

export interface CreatorTypeDefinition {
  creatorType: string;
  label: string;
  primary?: boolean;
}

export interface ItemTypeDefinition {
  itemType: CanonicalItemType;
  label: string;
  category:
    | 'academic'
    | 'books'
    | 'articles'
    | 'legal'
    | 'media'
    | 'documents'
    | 'special';
  fields: ItemFieldDefinition[];
  creatorTypes: CreatorTypeDefinition[];
  primaryCreatorType: string;
  isBibliographic: boolean;
  isSpecial: boolean;
  source: string;
  schemaVersion: number;
}

export interface SchemaRegistrySnapshot {
  version: number;
  registryVersion?: number;
  source: string;
  itemTypes: Record<string, ItemTypeDefinition>;
  baseFieldMappings: Record<string, Record<string, string>>; // [itemType][baseField] -> type-specific field
  reverseBaseFieldMappings: Record<string, Record<string, string>>; // [itemType][typeSpecificField] -> baseField
  creatorRoles: Record<string, string>;
  distinctFieldKeys: string[];
  cslTypeMap: Record<string, string>; // itemType -> cslType
  cslCreatorMap: Record<string, string>; // zoteroCreatorType -> cslName
  cslFieldMap: Record<string, string>; // zoteroField -> cslField
}

export interface CreatorHarmonizationChange {
  index: number;
  originalName: string;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'normalized-to-primary' | 'fallback-to-contributor';
}

export interface SchemaValidationResult {
  valid: boolean;
  itemType: string;
  sanitizedItem: Record<string, unknown>;
  warnings: string[];
  demotedToExtra: Record<string, unknown>;
  creatorChanges: CreatorHarmonizationChange[];
}

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

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext<TTx = Prisma.TransactionClient> {
  tx: TTx;
  helpers: TransactionHelpers;
}
