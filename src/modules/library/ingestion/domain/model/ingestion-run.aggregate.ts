import { IngestionStatusVo } from '../value-objects/ingestion-status.vo';
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
} from '../events/ingestion-domain.event';

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
 * IngestionRun Aggregate Root (Processing Bounded Context - Supporting Domain).
 *
 * Encapsulates:
 * - Pipeline execution lifecycle state machine (PENDING -> RUNNING -> COMPENSATING -> COMPLETED / FAILED)
 * - Progress metrics tracking
 * - Step-by-step Saga execution tracking & compensation
 * - Processing domain events
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
    this._completedSteps = props.completedSteps ? [...props.completedSteps] : [];
    this._currentStep = props.currentStep ?? null;
    this._compensatedSteps = props.compensatedSteps ? [...props.compensatedSteps] : [];
    this._compensationReason = props.compensationReason ?? null;
  }

  public static create(props: CreateIngestionRunProps): IngestionRunAggregate {
    const id = props.id ?? crypto.randomUUID();
    const total = Math.max(0, props.totalItems ?? 0);
    const now = new Date();

    const aggregate = new IngestionRunAggregate({
      id,
      userId: props.userId,
      projectId: props.projectId,
      sourceType: props.sourceType || 'manual',
      status: IngestionStatusVo.create('RUNNING'),
      totalItems: total,
      processedItems: 0,
      failedItems: 0,
      startedAt: now,
      completedAt: null,
    });

    aggregate.recordEvent(
      new IngestionRunStartedDomainEvent(
        id,
        props.userId,
        props.sourceType || 'manual',
        total,
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

  // ── Business Methods ────────────────────────────────────────────────────────

  public recordProgress(processedCount: number, failedCount = 0): void {
    this._processedItems += processedCount;
    this._failedItems += failedCount;
  }

  // ── Saga Step Lifecycle Methods ─────────────────────────────────────────────

  public startStep(stageName: IngestionStageName): void {
    if (this._status.value !== 'RUNNING') {
      throw new Error(
        `Cannot start step "${stageName}" on run in status ${this._status.value}.`,
      );
    }
    this._currentStep = stageName;
    this.recordEvent(
      new IngestionStepStartedDomainEvent(
        this._id,
        stageName,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public completeStep(stageName: IngestionStageName, durationMs: number): void {
    if (!this._completedSteps.includes(stageName)) {
      this._completedSteps.push(stageName);
    }
    this._currentStep = null;
    this.recordEvent(
      new IngestionStepCompletedDomainEvent(
        this._id,
        stageName,
        durationMs,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public failStep(stageName: IngestionStageName, errorReason: string): void {
    this._currentStep = null;
    this.recordEvent(
      new IngestionStepFailedDomainEvent(
        this._id,
        stageName,
        errorReason,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public startCompensation(failedStage: IngestionStageName, reason: string): void {
    const nextStatus = IngestionStatusVo.create('COMPENSATING');
    if (this._status.canTransitionTo(nextStatus)) {
      this._status = nextStatus;
    }
    this._compensationReason = reason;
    this.recordEvent(
      new IngestionCompensationStartedDomainEvent(
        this._id,
        failedStage,
        reason,
        this._userId,
        this._projectId ?? undefined,
      ),
    );
  }

  public recordCompensatedStep(stageName: IngestionStageName): void {
    if (!this._compensatedSteps.includes(stageName)) {
      this._compensatedSteps.push(stageName);
    }
  }

  public completeCompensation(): void {
    this.recordEvent(
      new IngestionCompensationCompletedDomainEvent(
        this._id,
        [...this._compensatedSteps],
        this._userId,
        this._projectId ?? undefined,
      ),
    );
    this.fail(this._compensationReason || 'Saga compensation completed');
  }

  public complete(): void {
    const nextStatus = IngestionStatusVo.create('COMPLETED');
    if (!this._status.canTransitionTo(nextStatus)) {
      throw new Error(
        `Cannot transition from ${this._status.value} to COMPLETED.`,
      );
    }

    this._status = nextStatus;
    this._completedAt = new Date();

    this.recordEvent(
      new IngestionRunCompletedDomainEvent(
        this._id,
        this._userId,
        this._processedItems,
        this._failedItems,
        this._projectId ?? undefined,
      ),
    );
  }

  public fail(reason: string): void {
    const nextStatus = IngestionStatusVo.create('FAILED');
    if (!this._status.canTransitionTo(nextStatus)) {
      throw new Error(
        `Cannot transition from ${this._status.value} to FAILED.`,
      );
    }

    this._status = nextStatus;
    this._errorReason = reason;
    this._completedAt = new Date();

    this.recordEvent(
      new IngestionRunFailedDomainEvent(
        this._id,
        this._userId,
        reason,
        this._projectId ?? undefined,
      ),
    );
  }

  // ── Domain Events ───────────────────────────────────────────────────────────

  private recordEvent(event: IProcessingDomainEvent): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): IProcessingDomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

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
}
