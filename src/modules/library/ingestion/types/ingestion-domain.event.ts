export interface IProcessingDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

export type IngestionStageName =
  | 'IDENTIFY'
  | 'NORMALIZE'
  | 'ENRICH'
  | 'RECONCILE'
  | 'MATCH'
  | 'COMMIT'
  | 'ENRICH_EXISTING';

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

export class IngestionStepStartedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.step_started';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly stageName: IngestionStageName,
    public readonly userId: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class IngestionStepCompletedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.step_completed';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly stageName: IngestionStageName,
    public readonly durationMs: number,
    public readonly userId: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class IngestionStepFailedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.step_failed';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly stageName: IngestionStageName,
    public readonly errorReason: string,
    public readonly userId: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class IngestionCompensationStartedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.compensation_started';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly failedStage: IngestionStageName,
    public readonly reason: string,
    public readonly userId: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class IngestionCompensationCompletedDomainEvent implements IProcessingDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'processing.ingestion_run.compensation_completed';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly compensatedStages: IngestionStageName[],
    public readonly userId: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}
