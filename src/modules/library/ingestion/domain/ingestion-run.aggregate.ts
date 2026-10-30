import { IngestionStatusVo } from './ingestion-status.vo';
import { InvalidStateTransitionException } from '@/modules/library/core/errors/domain.exception';

export type IngestionStageName =
  | 'IDENTIFY'
  | 'NORMALIZE'
  | 'ENRICH'
  | 'RECONCILE'
  | 'MATCH'
  | 'COMMIT'
  | 'ENRICH_EXISTING'
  | 'RESOLVE';

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
    return new IngestionRunAggregate({
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

  public startStep(stageName: IngestionStageName): void {
    if (this._status.value !== 'RUNNING') {
      throw new InvalidStateTransitionException(
        `Cannot start step "${stageName}" on run in status ${this._status.value}`,
        { currentStatus: this._status.value, targetStage: stageName },
      );
    }
    this._currentStep = stageName;
  }

  public completeStep(
    stageName: IngestionStageName,
    _durationMs: number = 0,
  ): void {
    if (!this._completedSteps.includes(stageName)) {
      this._completedSteps.push(stageName);
    }
    this._currentStep = null;
  }

  public failStep(
    _stageName: IngestionStageName,
    errorReason: string,
  ): void {
    this._currentStep = null;
    this._errorReason = errorReason;
  }

  public startCompensation(
    _failedStage: IngestionStageName,
    reason: string,
  ): void {
    this._status = IngestionStatusVo.create('COMPENSATING');
    this._compensationReason = reason;
    this._errorReason = reason;
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
    if (this._compensatedSteps.length === 0) {
      this._compensatedSteps = [...this._completedSteps].reverse();
    }
  }

  public recordProgress(processedDelta: number, failedDelta: number = 0): void {
    this._processedItems += processedDelta;
    this._failedItems += failedDelta;
  }

  public complete(processedItems = 1): void {
    const nextStatus = IngestionStatusVo.create('COMPLETED');
    if (!this._status.canTransitionTo(nextStatus)) {
      throw new InvalidStateTransitionException(
        `Cannot transition from status "${this._status.value}" to "COMPLETED" for run ${this._id}`,
        {
          currentStatus: this._status.value,
          targetStatus: 'COMPLETED',
          runId: this._id,
        },
      );
    }

    this._status = nextStatus;
    this._processedItems = processedItems;
    this._completedAt = new Date();
  }

  public fail(reason: string, failedItems = 1, isRetryable = false): void {
    const nextStatusStr = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    const nextStatus = IngestionStatusVo.create(nextStatusStr);

    if (!this._status.canTransitionTo(nextStatus)) {
      throw new InvalidStateTransitionException(
        `Cannot transition from status "${this._status.value}" to "${nextStatusStr}" for run ${this._id}`,
        {
          currentStatus: this._status.value,
          targetStatus: nextStatusStr,
          runId: this._id,
        },
      );
    }

    this._status = nextStatus;
    this._failedItems = failedItems;
    this._errorReason = reason;
    this._completedAt = new Date();
  }
}

