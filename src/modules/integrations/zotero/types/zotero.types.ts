export interface SchemaFieldDefinition {
  field: string;
  label: string;
  placeholder?: string;
  type: 'text' | 'textarea' | 'date' | 'number' | 'url';
  category?:
    'core' | 'venue' | 'publication' | 'identifiers' | 'archive' | 'extra';
}

export interface SchemaCreatorTypeDefinition {
  creatorType: string;
  label: string;
  primary?: boolean;
}

export interface SchemaItemTypeDefinition {
  itemType: string;
  label: string;
  category: 'academic' | 'books' | 'articles' | 'legal' | 'media' | 'documents';
  primaryCreatorType: string;
  creatorTypes: SchemaCreatorTypeDefinition[];
  fields: SchemaFieldDefinition[];
}
