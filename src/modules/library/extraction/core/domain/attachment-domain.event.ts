export interface IContentDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

export class AttachmentCreatedDomainEvent implements IContentDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'content.attachment.created';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly itemId: string,
    public readonly filename: string,
    public readonly mimeType: string,
    public readonly sizeBytes: number,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class AttachmentRevisionAddedDomainEvent implements IContentDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'content.attachment.revision_added';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly itemId: string,
    public readonly revisionNumber: number,
    public readonly sizeBytes: number,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class AttachmentExtractedDomainEvent implements IContentDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'content.attachment.extracted';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly itemId: string,
    public readonly pageCount: number,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}
