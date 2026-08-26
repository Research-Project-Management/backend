export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  inProgress: boolean;
  statusCode?: number;
  responseBody?: unknown;
}

export interface SaveIdempotencyResultInput {
  idempotencyKey: string;
  workspaceId: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
  ttlSeconds?: number;
}
