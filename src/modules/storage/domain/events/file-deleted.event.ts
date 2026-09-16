export class FileDeletedEvent {
  constructor(
    public readonly fileId: string,
    public readonly blobId: string | null,
    public readonly authorId: string,
    public readonly projectId?: string | null,
    public readonly permanent = false,
  ) {}
}
