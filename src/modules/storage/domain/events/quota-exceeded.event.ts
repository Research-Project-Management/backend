export class QuotaExceededEvent {
  constructor(
    public readonly userId: string | null,
    public readonly projectId: string | null,
    public readonly requestedBytes: bigint,
    public readonly currentUsedBytes: bigint,
    public readonly maxBytes: bigint,
  ) {}
}
