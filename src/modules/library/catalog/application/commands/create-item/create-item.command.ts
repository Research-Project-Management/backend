export interface CreateItemCommand {
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  fields?: Record<string, any>;
  idempotencyKey?: string;
  correlationId?: string;
}
