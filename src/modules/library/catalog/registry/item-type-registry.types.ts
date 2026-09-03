/**
 * Core Item-Type Registry Types for Flux Library.
 * Defines the canonical bibliographic item-type registry owned by the Library domain.
 */

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
  itemType: string;
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
}
