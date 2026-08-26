export type RelationType =
  | 'cites'
  | 'cited_by'
  | 'replicates'
  | 'extends'
  | 'is_preprint_of'
  | 'is_published_version_of'
  | 'is_translation_of'
  | 'supplements'
  | 'related'
  | 'rebuts'
  | 'uses_dataset'
  | 'survey_of';

export interface StoredRelation {
  id?: string;
  sourceId?: string;
  sourceItemId?: string;
  sourcePaperId?: string;
  targetId?: string;
  targetItemId?: string;
  targetPaperId?: string;
  relationType?: RelationType;
  type?: RelationType;
  description?: string;
  note?: string;
  createdAt?: string;
  linkedAt?: string;
}

export interface RelatedItem {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  itemType?: string;
  citationKey?: string;
  relationType: RelationType;
  description?: string;
  note?: string;
  createdAt?: string;
  linkedAt?: string;
}

export interface GraphNode {
  id: string;
  label?: string;
  title?: string;
  citationKey?: string;
  year: number | null;
  authors: string[];
  itemType?: string;
  degree?: number;
}

export interface GraphEdge {
  id?: string;
  source: string;
  target: string;
  relationType: RelationType;
  description?: string;
  note?: string;
}

export interface RelationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
}

// Backward-compatible aliases
export type RelatedLibraryItem = RelatedItem;
export type LibraryRelationGraph = RelationGraph;
