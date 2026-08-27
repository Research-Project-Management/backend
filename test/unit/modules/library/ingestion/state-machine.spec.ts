import {
  IngestionState,
  IngestionStateMachine,
  ALLOWED_STATE_TRANSITIONS,
} from '@/modules/library/legacy/translation/jobs.state';

describe('IngestionStateMachine (12-State Formal Model)', () => {
  let sm: IngestionStateMachine;

  beforeEach(() => {
    sm = new IngestionStateMachine();
  });

  it('initializes with DISCOVERED state and records initial history', () => {
    expect(sm.currentState).toBe(IngestionState.DISCOVERED);
    expect(sm.history.length).toBe(1);
    expect(sm.history[0].from).toBe(IngestionState.DISCOVERED);
    expect(sm.isTerminal()).toBe(false);
    expect(sm.isFailed()).toBe(false);
  });

  it('transitions legally through a full happy path (DOI pipeline)', () => {
    // 1. DISCOVERED -> IDENTIFIER_RESOLVED
    sm.transitionTo(
      IngestionState.IDENTIFIER_RESOLVED,
      'Normalized DOI: 10.1038/nature12345',
    );
    expect(sm.currentState).toBe(IngestionState.IDENTIFIER_RESOLVED);

    // 2. IDENTIFIER_RESOLVED -> FETCHING_PRIMARY
    sm.transitionTo(
      IngestionState.FETCHING_PRIMARY,
      'Dispatching CrossRef resolution',
    );
    expect(sm.currentState).toBe(IngestionState.FETCHING_PRIMARY);

    // 3. FETCHING_PRIMARY -> PRIMARY_RESOLVED
    sm.transitionTo(
      IngestionState.PRIMARY_RESOLVED,
      'CrossRef metadata received',
    );
    expect(sm.currentState).toBe(IngestionState.PRIMARY_RESOLVED);

    // 4. PRIMARY_RESOLVED -> FETCHING_ENRICHMENT
    sm.transitionTo(
      IngestionState.FETCHING_ENRICHMENT,
      'Querying OpenAlex and Semantic Scholar',
    );
    expect(sm.currentState).toBe(IngestionState.FETCHING_ENRICHMENT);

    // 5. FETCHING_ENRICHMENT -> ENRICHMENT_RESOLVED
    sm.transitionTo(
      IngestionState.ENRICHMENT_RESOLVED,
      'Enrichment payload collected',
    );
    expect(sm.currentState).toBe(IngestionState.ENRICHMENT_RESOLVED);

    // 6. ENRICHMENT_RESOLVED -> RECONCILING
    sm.transitionTo(
      IngestionState.RECONCILING,
      'Reconciling candidates and assertions',
    );
    expect(sm.currentState).toBe(IngestionState.RECONCILING);

    // 7. RECONCILING -> PROMOTED
    sm.transitionTo(
      IngestionState.PROMOTED,
      'Catalog item promoted and persisted',
    );
    expect(sm.currentState).toBe(IngestionState.PROMOTED);
    expect(sm.isTerminal()).toBe(true);
    expect(sm.isFailed()).toBe(false);
    expect(sm.history.length).toBe(8);
  });

  it('transitions legally through a PDF upload happy path', () => {
    // 1. DISCOVERED -> PARSING_LOCAL
    sm.transitionTo(IngestionState.PARSING_LOCAL, 'Parsing PDF byte stream');
    expect(sm.currentState).toBe(IngestionState.PARSING_LOCAL);

    // 2. PARSING_LOCAL -> LOCAL_PARSED
    sm.transitionTo(
      IngestionState.LOCAL_PARSED,
      'XMP metadata and DOI extracted',
    );
    expect(sm.currentState).toBe(IngestionState.LOCAL_PARSED);

    // 3. LOCAL_PARSED -> FETCHING_PRIMARY
    sm.transitionTo(
      IngestionState.FETCHING_PRIMARY,
      'Fetching primary metadata with extracted DOI',
    );
    expect(sm.currentState).toBe(IngestionState.FETCHING_PRIMARY);
  });

  it('handles recoverable failures with retry loop', () => {
    sm.transitionTo(IngestionState.IDENTIFIER_RESOLVED, 'DOI recognized');
    sm.transitionTo(IngestionState.FETCHING_PRIMARY, 'Contacting CrossRef');

    // Network timeout -> FAILED_RECOVERABLE
    sm.transitionTo(
      IngestionState.FAILED_RECOVERABLE,
      'HTTP 504 Gateway Timeout',
    );
    expect(sm.currentState).toBe(IngestionState.FAILED_RECOVERABLE);
    expect(sm.isFailed()).toBe(true);
    expect(sm.isTerminal()).toBe(false);

    // Retry transition -> FETCHING_PRIMARY
    sm.transitionTo(IngestionState.FETCHING_PRIMARY, 'Retry attempt 2');
    expect(sm.currentState).toBe(IngestionState.FETCHING_PRIMARY);
    expect(sm.isFailed()).toBe(false);
  });

  it('rejects illegal state transitions with descriptive error', () => {
    // Cannot transition directly from DISCOVERED to PROMOTED
    expect(sm.canTransitionTo(IngestionState.PROMOTED)).toBe(false);
    expect(() => {
      sm.transitionTo(IngestionState.PROMOTED, 'Direct jump');
    }).toThrow(/Illegal Ingestion State Transition/);
  });

  it('ensures terminal state PROMOTED has no outbound transitions', () => {
    expect(ALLOWED_STATE_TRANSITIONS[IngestionState.PROMOTED]).toEqual([]);
    expect(
      ALLOWED_STATE_TRANSITIONS[IngestionState.FAILED_UNRECOVERABLE],
    ).toEqual([]);
  });
});
