export type IngestionDomainStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * IngestionStatus Value Object enforcing valid pipeline lifecycle transitions.
 */
export class IngestionStatusVo {
  private readonly _value: IngestionDomainStatus;

  private static readonly VALID_STATUSES: Set<IngestionDomainStatus> = new Set([
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ]);

  private constructor(value: IngestionDomainStatus) {
    this._value = value;
  }

  public static create(rawStatus?: string | null): IngestionStatusVo {
    if (!rawStatus) return new IngestionStatusVo('PENDING');
    const upper = rawStatus.trim().toUpperCase() as IngestionDomainStatus;
    if (!IngestionStatusVo.VALID_STATUSES.has(upper)) {
      throw new Error(`Invalid Ingestion status: "${rawStatus}"`);
    }
    return new IngestionStatusVo(upper);
  }

  public get value(): IngestionDomainStatus {
    return this._value;
  }

  public canTransitionTo(next: IngestionStatusVo): boolean {
    if (
      this._value === 'COMPLETED' ||
      this._value === 'FAILED' ||
      this._value === 'CANCELLED'
    ) {
      return false; // Terminal states
    }
    if (this._value === 'PENDING') {
      return next.value === 'RUNNING' || next.value === 'CANCELLED';
    }
    if (this._value === 'RUNNING') {
      return (
        next.value === 'COMPLETED' ||
        next.value === 'FAILED' ||
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
