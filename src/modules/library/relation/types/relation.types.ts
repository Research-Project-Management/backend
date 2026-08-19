export type RelationType =
  | 'related'
  | 'extends'
  | 'rebuts'
  | 'uses_dataset'
  | 'survey_of';

export interface StoredRelation {
  targetPaperId: string;
  type: RelationType;
  note?: string;
  linkedAt: string;
}

export interface RelatedPaperItem {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  citationKey: string;
  relationType: RelationType;
  note?: string;
  linkedAt: string;
}

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
