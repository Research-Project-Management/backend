import { IngestionStatusVo } from './ingestion-status.vo';
import {
  IProcessingDomainEvent,
  IngestionRunStartedDomainEvent,
  IngestionRunCompletedDomainEvent,
  IngestionRunFailedDomainEvent,
  IngestionStageName,
  IngestionStepStartedDomainEvent,
  IngestionStepCompletedDomainEvent,
  IngestionStepFailedDomainEvent,
  IngestionCompensationStartedDomainEvent,
  IngestionCompensationCompletedDomainEvent,
} from './ingestion-domain.event';

export interface CreateIngestionRunProps {
  id?: string;
  userId: string;
  projectId?: string | null;
  sourceType: string;
  totalItems?: number;
}

export interface ReconstituteIngestionRunProps {
  id: string;
  userId: string;
  projectId?: string | null;
  sourceType: string;
  status: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  errorReason?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
  completedSteps?: IngestionStageName[];
  currentStep?: IngestionStageName | null;
  compensatedSteps?: IngestionStageName[];
  compensationReason?: string | null;
}

/**
 * IngestionRun Aggregate Root.
 */
export class IngestionRunAggregate {
  private readonly _id: string;
  private readonly _userId: string;
  private readonly _projectId?: string | null;
  private readonly _sourceType: string;
  private _status: IngestionStatusVo;
  private _totalItems: number;
  private _processedItems: number;
  private _failedItems: number;
  private _errorReason?: string | null;
  private readonly _startedAt: Date;
  private _completedAt?: Date | null;
  private _currentStep?: IngestionStageName | null;
  private _completedSteps: IngestionStageName[] = [];
  private _compensatedSteps: IngestionStageName[] = [];
  private _compensationReason?: string | null;

  private _domainEvents: IProcessingDomainEvent[] = [];

  private constructor(props: {
    id: string;
    userId: string;
    projectId?: string | null;
    sourceType: string;
    status: IngestionStatusVo;
    totalItems: number;
    processedItems: number;
    failedItems: number;
    errorReason?: string | null;
    startedAt: Date;
    completedAt?: Date | null;
    completedSteps?: IngestionStageName[];
    currentStep?: IngestionStageName | null;
    compensatedSteps?: IngestionStageName[];
    compensationReason?: string | null;
  }) {
    this._id = props.id;
    this._userId = props.userId;
    this._projectId = props.projectId;
    this._sourceType = props.sourceType;
    this._status = props.status;
    this._totalItems = props.totalItems;
    this._processedItems = props.processedItems;
    this._failedItems = props.failedItems;
    this._errorReason = props.errorReason;
    this._startedAt = props.startedAt;
    this._completedAt = props.completedAt;
    this._completedSteps = props.completedSteps
      ? [...props.completedSteps]
      : [];
    this._currentStep = props.currentStep ?? null;
    this._compensatedSteps = props.compensatedSteps
      ? [...props.compensatedSteps]
      : [];
    this._compensationReason = props.compensationReason ?? null;
  }

  public static create(props: CreateIngestionRunProps): IngestionRunAggregate {
    const id = props.id || crypto.randomUUID();
    const aggregate = new IngestionRunAggregate({
      id,
      userId: props.userId,
      projectId: props.projectId,
      sourceType: props.sourceType,
      status: IngestionStatusVo.create('RUNNING'),
      totalItems: props.totalItems || 1,
      processedItems: 0,
      failedItems: 0,
      startedAt: new Date(),
    });

    aggregate._domainEvents.push(
      new IngestionRunStartedDomainEvent(
        id,
        props.userId,
        props.sourceType,
        props.totalItems || 1,
        props.projectId ?? undefined,
      ),
    );

    return aggregate;
  }

  public static reconstitute(
    props: ReconstituteIngestionRunProps,
  ): IngestionRunAggregate {
    return new IngestionRunAggregate({
      id: props.id,
      userId: props.userId,
      projectId: props.projectId,
      sourceType: props.sourceType,
      status: IngestionStatusVo.create(props.status),
      totalItems: props.totalItems,
      processedItems: props.processedItems,
      failedItems: props.failedItems,
      errorReason: props.errorReason,
      startedAt: props.startedAt,
      completedAt: props.completedAt,
      completedSteps: props.completedSteps,
      currentStep: props.currentStep,
      compensatedSteps: props.compensatedSteps,
      compensationReason: props.compensationReason,
    });
  }

  public get id(): string {
    return this._id;
  }
  public get userId(): string {
    return this._userId;
  }
  public get projectId(): string | null | undefined {
    return this._projectId;
  }
  public get sourceType(): string {
    return this._sourceType;
  }
  public get status(): string {
    return this._status.value;
  }
  public get totalItems(): number {
    return this._totalItems;
  }
  public get processedItems(): number {
    return this._processedItems;
  }
  public get failedItems(): number {
    return this._failedItems;
  }
  public get errorReason(): string | null | undefined {
    return this._errorReason;
  }
  public get startedAt(): Date {
    return this._startedAt;
  }
  public get completedAt(): Date | null | undefined {
    return this._completedAt;
  }
  public get currentStep(): IngestionStageName | null | undefined {
    return this._currentStep;
  }
  public get completedSteps(): IngestionStageName[] {
    return [...this._completedSteps];
  }
  public get compensatedSteps(): IngestionStageName[] {
    return [...this._compensatedSteps];
  }
  public get compensationReason(): string | null | undefined {
    return this._compensationReason;
  }

  public get domainEvents(): IProcessingDomainEvent[] {
    return [...this._domainEvents];
  }

  public clearDomainEvents(): void {
    this._domainEvents = [];
  }

  public pullDomainEvents(): IProcessingDomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }

  public markStepStarted(stageName: IngestionStageName): void {
    if (this._status.value !== 'RUNNING') {
      throw new Error(
        `Cannot start step "${stageName}" on run in status ${this._status.value}`,
      );
    }
    this._currentStep = stageName;
    this._domainEvents.push(
      new IngestionStepStartedDomainEvent(
        this._id,
        stageName,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public markStepCompleted(
    stageName: IngestionStageName,
    durationMs: number = 0,
  ): void {
    if (!this._completedSteps.includes(stageName)) {
      this._completedSteps.push(stageName);
    }
    this._currentStep = null;
    this._domainEvents.push(
      new IngestionStepCompletedDomainEvent(
        this._id,
        stageName,
        durationMs,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public markStepFailed(
    stageName: IngestionStageName,
    errorReason: string,
  ): void {
    this._currentStep = null;
    this._errorReason = errorReason;
    this._domainEvents.push(
      new IngestionStepFailedDomainEvent(
        this._id,
        stageName,
        errorReason,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public startCompensation(
    failedStage: IngestionStageName,
    reason: string,
  ): void {
    this._status = IngestionStatusVo.create('COMPENSATING');
    this._compensationReason = reason;
    this._errorReason = reason;
    this._domainEvents.push(
      new IngestionCompensationStartedDomainEvent(
        this._id,
        failedStage,
        reason,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public markCompensationCompleted(): void {
    if (this._compensatedSteps.length === 0) {
      this._compensatedSteps = [...this._completedSteps].reverse();
    }
    this._domainEvents.push(
      new IngestionCompensationCompletedDomainEvent(
        this._id,
        this._compensatedSteps,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  // Saga Orchestrator & Pipeline Step Helpers
  public startStep(stageName: IngestionStageName): void {
    this.markStepStarted(stageName);
  }

  public completeStep(
    stageName: IngestionStageName,
    durationMs: number = 0,
  ): void {
    this.markStepCompleted(stageName, durationMs);
  }

  public failStep(stageName: IngestionStageName, errorMessage: string): void {
    this.markStepFailed(stageName, errorMessage);
  }

  public recordCompensatedStep(stageName: IngestionStageName): void {
    if (!this._compensatedSteps.includes(stageName)) {
      this._compensatedSteps.push(stageName);
    }
  }

  public completeCompensation(): void {
    this._status = IngestionStatusVo.create('FAILED_FINAL');
    if (!this._errorReason) {
      this._errorReason = this._compensationReason;
    }
    this.markCompensationCompleted();
    this._domainEvents.push(
      new IngestionRunFailedDomainEvent(
        this._id,
        this._userId,
        this._errorReason || 'Compensation completed with failure',
        this._projectId ?? undefined,
      ),
    );
  }

  public recordProgress(processedDelta: number, failedDelta: number = 0): void {
    this._processedItems += processedDelta;
    this._failedItems += failedDelta;
  }

  public complete(processedItems = 1): void {
    const nextStatus = IngestionStatusVo.create('COMPLETED');
    if (!this._status.canTransitionTo(nextStatus)) {
      throw new Error(
        `Cannot transition from status "${this._status.value}" to "COMPLETED" for run ${this._id}`,
      );
    }

    this._status = nextStatus;
    this._processedItems = processedItems;
    this._completedAt = new Date();

    this._domainEvents.push(
      new IngestionRunCompletedDomainEvent(
        this._id,
        this._userId,
        this._processedItems,
        this._failedItems,
        this._projectId ?? undefined,
      ),
    );
  }

  public fail(reason: string, failedItems = 1, isRetryable = false): void {
    const nextStatusStr = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    const nextStatus = IngestionStatusVo.create(nextStatusStr);

    if (!this._status.canTransitionTo(nextStatus)) {
      this._status = nextStatus;
    } else {
      this._status = nextStatus;
    }

    this._failedItems = failedItems;
    this._errorReason = reason;
    this._completedAt = new Date();

    this._domainEvents.push(
      new IngestionRunFailedDomainEvent(
        this._id,
        this._userId,
        reason,
        this._projectId ?? undefined,
      ),
    );
  }
}
