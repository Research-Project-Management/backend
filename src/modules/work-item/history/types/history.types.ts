export interface PropertyHistoryItem {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actor?: {
    id: string;
    name: string;
    email: string | null;
    avatar: string | null;
  } | null;
  createdAt: Date;
  diffSummary?: string;
}

export interface WorkItemHistoryResponse {
  taskId: string;
  total: number;
  histories: PropertyHistoryItem[];
}
