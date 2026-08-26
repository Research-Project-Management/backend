export interface DuplicateGroupItem {
  id: string;
  title: string;
  year?: number | null;
  authors?: string[];
  doi?: string | null;
  dateAdded?: string;
}

export interface DuplicateGroup {
  id: string;
  confidence: 'high' | 'medium';
  reason: string;
  items: DuplicateGroupItem[];
}

export interface IntegrityIssue {
  itemId: string;
  title: string;
  issue: string;
  severity: 'warning' | 'error';
}

export interface IntegrityReport {
  totalItems: number;
  missingDoiCount: number;
  missingYearCount: number;
  missingAuthorsCount: number;
  issues: IntegrityIssue[];
}
