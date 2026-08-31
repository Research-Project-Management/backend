export type ItemRelationType =
  | 'cites'
  | 'cited_by'
  | 'replicates'
  | 'extends'
  | 'is_preprint_of'
  | 'is_published_version_of'
  | 'is_translation_of'
  | 'supplements';

export interface ItemRelation {
  id: string;
  workspaceId: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: ItemRelationType;
  description?: string;
  createdAt: Date;
}

export interface ItemRelationInput {
  targetItemId: string;
  relationType: ItemRelationType;
  description?: string;
}
