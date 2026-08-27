/**
 * Translation State Machine (12-State Formal Model)
 *
 * Models the complete lifecycle of academic document translation and ingestion, from initial discovery
 * through multi-source resolution, deep PDF extraction, provenance reconciliation,
 * and promotion into the workspace catalog.
 */

export enum IngestionState {
  DISCOVERED = 'DISCOVERED',
  IDENTIFIER_RESOLVED = 'IDENTIFIER_RESOLVED',
  FETCHING_PRIMARY = 'FETCHING_PRIMARY',
  PRIMARY_RESOLVED = 'PRIMARY_RESOLVED',
  FETCHING_ENRICHMENT = 'FETCHING_ENRICHMENT',
  ENRICHMENT_RESOLVED = 'ENRICHMENT_RESOLVED',
  PARSING_LOCAL = 'PARSING_LOCAL',
  LOCAL_PARSED = 'LOCAL_PARSED',
  RECONCILING = 'RECONCILING',
  PROMOTED = 'PROMOTED',
  FAILED_RECOVERABLE = 'FAILED_RECOVERABLE',
  FAILED_UNRECOVERABLE = 'FAILED_UNRECOVERABLE',
}

export { IngestionState as TranslationState };

export interface StateTransitionRecord {
  from: IngestionState;
  to: IngestionState;
  timestamp: string;
  reason?: string;
}

export const ALLOWED_STATE_TRANSITIONS: Record<
  IngestionState,
  IngestionState[]
> = {
  [IngestionState.DISCOVERED]: [
    IngestionState.IDENTIFIER_RESOLVED,
    IngestionState.PARSING_LOCAL,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.IDENTIFIER_RESOLVED]: [
    IngestionState.FETCHING_PRIMARY,
    IngestionState.PARSING_LOCAL,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.FETCHING_PRIMARY]: [
    IngestionState.PRIMARY_RESOLVED,
    IngestionState.PARSING_LOCAL,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.PRIMARY_RESOLVED]: [
    IngestionState.FETCHING_ENRICHMENT,
    IngestionState.PARSING_LOCAL,
    IngestionState.RECONCILING,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.FETCHING_ENRICHMENT]: [
    IngestionState.ENRICHMENT_RESOLVED,
    IngestionState.RECONCILING,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.ENRICHMENT_RESOLVED]: [
    IngestionState.PARSING_LOCAL,
    IngestionState.RECONCILING,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.PARSING_LOCAL]: [
    IngestionState.LOCAL_PARSED,
    IngestionState.RECONCILING,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.LOCAL_PARSED]: [
    IngestionState.FETCHING_PRIMARY,
    IngestionState.RECONCILING,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.RECONCILING]: [
    IngestionState.PROMOTED,
    IngestionState.FAILED_RECOVERABLE,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.PROMOTED]: [],
  [IngestionState.FAILED_RECOVERABLE]: [
    IngestionState.DISCOVERED,
    IngestionState.FETCHING_PRIMARY,
    IngestionState.FETCHING_ENRICHMENT,
    IngestionState.PARSING_LOCAL,
    IngestionState.RECONCILING,
    IngestionState.FAILED_UNRECOVERABLE,
  ],
  [IngestionState.FAILED_UNRECOVERABLE]: [],
};

export class TranslationStateMachine {
  private _currentState: IngestionState;
  private readonly _history: StateTransitionRecord[] = [];

  constructor(initialState: IngestionState = IngestionState.DISCOVERED) {
    this._currentState = initialState;
    this._history.push({
      from: initialState,
      to: initialState,
      timestamp: new Date().toISOString(),
      reason: 'Initial state',
    });
  }

  get currentState(): IngestionState {
    return this._currentState;
  }

  get history(): ReadonlyArray<StateTransitionRecord> {
    return [...this._history];
  }

  canTransitionTo(nextState: IngestionState): boolean {
    const allowed = ALLOWED_STATE_TRANSITIONS[this._currentState] || [];
    return allowed.includes(nextState);
  }

  transitionTo(nextState: IngestionState, reason?: string): void {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(
        `Illegal Ingestion State Transition: cannot transition from ${this._currentState} to ${nextState}. Reason: ${
          reason || 'Unspecified'
        }`,
      );
    }

    const prev = this._currentState;
    this._currentState = nextState;
    this._history.push({
      from: prev,
      to: nextState,
      timestamp: new Date().toISOString(),
      reason,
    });
  }

  isTerminal(): boolean {
    return (
      this._currentState === IngestionState.PROMOTED ||
      this._currentState === IngestionState.FAILED_UNRECOVERABLE
    );
  }

  isFailed(): boolean {
    return (
      this._currentState === IngestionState.FAILED_RECOVERABLE ||
      this._currentState === IngestionState.FAILED_UNRECOVERABLE
    );
  }
}

export { TranslationStateMachine as IngestionStateMachine };
