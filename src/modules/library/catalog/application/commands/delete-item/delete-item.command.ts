export interface DeleteItemCommand {
  userId: string;
  itemId: string;
  projectId?: string | null;
  expectedVersion?: number;
  correlationId?: string;
}
