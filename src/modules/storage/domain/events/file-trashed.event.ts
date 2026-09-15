export class FileTrashedEvent {
  constructor(
    public readonly fileId: string,
    public readonly authorId: string,
    public readonly trashedAt: Date,
    public readonly projectId?: string | null,
  ) {}
}
