export interface IProcessingDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

export class IngestionRunStartedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.started';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly sourceType: string,
    public readonly totalItems: number,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class IngestionRunCompletedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.completed';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly processedItems: number,
    public readonly failedItems: number,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class IngestionRunFailedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.failed';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly errorReason: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}
