export interface RestoreItemCommand {
  userId: string;
  itemId: string;
  expectedVersion?: number;
  projectId?: string | null;
  correlationId?: string;
}
