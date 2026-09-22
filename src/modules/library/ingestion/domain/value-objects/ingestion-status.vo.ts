export type IngestionDomainStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELLED'
  | 'STALLED'
  | 'COMPENSATING';

/**
 * IngestionStatus Value Object enforcing valid pipeline lifecycle transitions.
 */
export class IngestionStatusVo {
  private readonly _value: IngestionDomainStatus;

  private static readonly VALID_STATUSES: Set<IngestionDomainStatus> = new Set([
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'CANCELLED',
    'STALLED',
    'COMPENSATING',
  ]);

  private constructor(value: IngestionDomainStatus) {
    this._value = value;
  }

  public static create(rawStatus?: string | null): IngestionStatusVo {
    if (!rawStatus) return new IngestionStatusVo('PENDING');
    const upper = rawStatus.trim().toUpperCase();
    // Map legacy aliases
    let normalized = upper;
    if (upper === 'READY') normalized = 'COMPLETED';
    if (upper === 'FAILED') normalized = 'FAILED_FINAL';
    if (upper === 'NEEDS_REVIEW') normalized = 'COMPLETED'; // Zotero model: completed with duplicate review flag
    if (!IngestionStatusVo.VALID_STATUSES.has(normalized as IngestionDomainStatus)) {
      throw new Error(`Invalid Ingestion status: "${rawStatus}"`);
    }
    return new IngestionStatusVo(normalized as IngestionDomainStatus);
  }

  public get value(): IngestionDomainStatus {
    return this._value;
  }

  public get isCompensating(): boolean {
    return this._value === 'COMPENSATING';
  }

  public get isTerminal(): boolean {
    return (
      this._value === 'COMPLETED' ||
      this._value === 'FAILED_FINAL' ||
      this._value === 'CANCELLED'
    );
  }

  public canTransitionTo(next: IngestionStatusVo): boolean {
    if (this.isTerminal) {
      return false; // Terminal states cannot transition
    }

    if (this._value === 'PENDING') {
      return next.value === 'RUNNING' || next.value === 'CANCELLED';
    }

    if (this._value === 'RUNNING') {
      return (
        next.value === 'COMPLETED' ||
        next.value === 'FAILED_RETRYABLE' ||
        next.value === 'FAILED_FINAL' ||
        next.value === 'CANCELLED' ||
        next.value === 'STALLED' ||
        next.value === 'COMPENSATING'
      );
    }

    if (this._value === 'FAILED_RETRYABLE') {
      return (
        next.value === 'PENDING' ||
        next.value === 'RUNNING' ||
        next.value === 'CANCELLED' ||
        next.value === 'FAILED_FINAL'
      );
    }

    if (this._value === 'STALLED') {
      return (
        next.value === 'PENDING' ||
        next.value === 'RUNNING' ||
        next.value === 'FAILED_FINAL'
      );
    }

    if (this._value === 'COMPENSATING') {
      return (
        next.value === 'FAILED_FINAL' ||
        next.value === 'FAILED_RETRYABLE' ||
        next.value === 'CANCELLED'
      );
    }

    return false;
  }

  public equals(other?: IngestionStatusVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
