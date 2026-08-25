export type RelationType =
  'related' | 'extends' | 'rebuts' | 'uses_dataset' | 'survey_of';

export interface StoredRelation {
  targetItemId?: string;
  targetPaperId?: string;
  type: RelationType;
  note?: string;
  linkedAt: string;
}

export interface RelatedKnowledgeItem {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  citationKey: string;
  relationType: RelationType;
  note?: string;
  linkedAt: string;
}

// Alias for backward compatibility
export type RelatedPaperItem = RelatedKnowledgeItem;

export interface GraphNode {
  id: string;
  label: string;
  citationKey: string;
  year: number | null;
  authors: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  relationType: RelationType;
  note?: string;
}

export interface LibraryKnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
}
