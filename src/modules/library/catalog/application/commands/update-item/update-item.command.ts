export interface UpdateItemCommand {
  userId: string;
  itemId: string;
  projectId?: string | null;
  expectedVersion?: number;
  changes: {
    title?: string;
    itemType?: string;
    doi?: string | null;
    citationKey?: string | null;
    abstract?: string | null;
    year?: number | null;
    publicationTitle?: string | null;
    fields?: Record<string, any>;
  };
  correlationId?: string;
}
