import { DuplicatePolicy } from '@/modules/library/ingestion/policies/duplicate.policy';

describe('DuplicatePolicy', () => {
  let policy: DuplicatePolicy;

  beforeEach(() => {
    policy = new DuplicatePolicy();
  });

  it('detects EXACT duplicate when DOI matches within the workspace', () => {
    const proposed = {
      title: 'Attention Is All You Need',
      doi: '10.5555/3295222.3295349',
    };

    const existing = [
      {
        id: 'item-100',
        title: 'Attention Is All You Need (Preprint)',
        doi: '10.5555/3295222.3295349',
        year: 2017,
      },
    ];

    const result = policy.evaluate(proposed, existing);
    expect(result.matchType).toBe('EXACT');
    expect(result.targetItemId).toBe('item-100');
    expect(result.matchReason).toBe('DOI_EXACT');
  });

  it('detects PROBABLE duplicate when title is identical and publication year matches without DOI', () => {
    const proposed = {
      title: 'Deep Residual Learning for Image Recognition',
      year: 2016,
      authors: ['Kaiming He'],
    };

    const existing = [
      {
        id: 'item-200',
        title: 'Deep Residual Learning for Image Recognition',
        year: 2016,
        authors: ['He, Kaiming'],
      },
    ];

    const result = policy.evaluate(proposed, existing);
    expect(result.matchType).toBe('PROBABLE');
    expect(result.targetItemId).toBe('item-200');
    expect(result.matchReason).toBe('TITLE_FUZZY');
  });

  it('returns NO_MATCH when title and identifiers are completely distinct', () => {
    const proposed = {
      title: 'A New Quantum Computing Paradigm',
      year: 2024,
      doi: '10.1000/182',
    };

    const existing = [
      {
        id: 'item-300',
        title: 'Classical Electrodynamics',
        doi: '10.1000/181',
        year: 1998,
      },
    ];

    const result = policy.evaluate(proposed, existing);
    expect(result.matchType).toBe('NO_MATCH');
    expect(result.targetItemId).toBeUndefined();
  });
});
