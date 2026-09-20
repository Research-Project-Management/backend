/**
 * Core Item-Type Schema & Registry Types for Flux Library.
 * Defines the canonical bibliographic item-type registry owned by the Library domain.
 */
export * from '../../../shared-kernel/core/types/branded.types';

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
  label: string;
  baseField?: string;
  order: number;
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

export interface BaseFieldMapping {
  itemType: string;
  field: string;
  baseField: string;
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
  sanitizedItem: Record<string, any>;
  warnings: string[];
  demotedToExtra: Record<string, any>;
  creatorChanges: CreatorHarmonizationChange[];
}

const CANONICAL_ITEM_TYPES_SET = new Set<string>([
  'journalArticle',
  'preprint',
  'conferencePaper',
  'thesis',
  'report',
  'dataset',
  'presentation',
  'standard',
  'book',
  'bookSection',
  'manuscript',
  'dictionaryEntry',
  'encyclopediaArticle',
  'magazineArticle',
  'newspaperArticle',
  'bill',
  'case',
  'hearing',
  'statute',
  'patent',
  'audioRecording',
  'videoRecording',
  'film',
  'radioBroadcast',
  'tvBroadcast',
  'podcast',
  'artwork',
  'map',
  'blogPost',
  'webpage',
  'forumPost',
  'letter',
  'interview',
  'document',
  'email',
  'instantMessage',
  'computerProgram',
  'annotation',
  'attachment',
  'note',
]);

/**
 * Type guard for CanonicalItemType (Matt Pocock Pattern).
 */
export function isCanonicalItemType(type: unknown): type is CanonicalItemType {
  return typeof type === 'string' && CANONICAL_ITEM_TYPES_SET.has(type);
}
