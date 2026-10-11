export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  inProgress: boolean;
  statusCode?: number;
  responseBody?: unknown;
}

export interface SaveIdempotencyResultInput {
  idempotencyKey: string;
  userId: string;
  projectId?: string;
  requestHash?: string;
  statusCode: number;
  responseBody: unknown;
  ttlSeconds?: number;
}
