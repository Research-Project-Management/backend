// ============================================================================
// CORE STORAGE EVENTS
// ============================================================================

export class FileUploadedEvent {
  constructor(
    public readonly fileId: string,
    public readonly blobId: string,
    public readonly authorId: string,
    public readonly filename: string,
    public readonly mimeType: string,
    public readonly sizeBytes: bigint,
    public readonly s3Key: string,
    public readonly projectId?: string | null,
  ) {}
}

export class FileDownloadedEvent {
  constructor(
    public readonly fileId: string,
    public readonly filename: string,
    public readonly mimeType: string,
    public readonly sizeBytes: number,
    public readonly accessedBy?: string | null,
    public readonly clientIp?: string | null,
    public readonly projectId?: string | null,
    public readonly timestamp: Date = new Date(),
  ) {}
}
