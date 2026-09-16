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
