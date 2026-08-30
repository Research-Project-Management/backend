import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';

describe('ReconciliationPolicy', () => {
  let policy: ReconciliationPolicy;

  beforeEach(() => {
    policy = new ReconciliationPolicy();
  });

  it('selects highest confidence provider field and records provenance', () => {
    const candidate1: MetadataCandidate = {
      candidateId: 'cand-1',
      sourceKind: 'RECORD',
      sourceName: 'BibTeX',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      confidenceScore: 0.6,
      normalizedMetadata: {
        title: 'Deep learning',
        year: 2015,
      },
      fields: {
        title: {
          path: 'title',
          value: 'Deep learning',
          normalizedValue: 'Deep learning',
          confidence: 0.6,
          sourceProvider: 'BibTeX',
          retrievedAt: new Date().toISOString(),
        },
        year: {
          path: 'year',
          value: 2015,
          normalizedValue: 2015,
          confidence: 0.6,
          sourceProvider: 'BibTeX',
          retrievedAt: new Date().toISOString(),
        },
      },
    };

    const candidate2: MetadataCandidate = {
      candidateId: 'cand-2',
      sourceKind: 'PROVIDER',
      sourceName: 'CrossRef',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      confidenceScore: 0.95,
      normalizedMetadata: {
        title: 'Deep Learning Review',
        doi: '10.1038/nature14539',
        year: 2015,
      },
      fields: {
        title: {
          path: 'title',
          value: 'Deep Learning Review',
          normalizedValue: 'Deep Learning Review',
          confidence: 0.95,
          sourceProvider: 'CrossRef',
          retrievedAt: new Date().toISOString(),
        },
        doi: {
          path: 'doi',
          value: '10.1038/nature14539',
          normalizedValue: '10.1038/nature14539',
          confidence: 0.95,
          sourceProvider: 'CrossRef',
          retrievedAt: new Date().toISOString(),
        },
        year: {
          path: 'year',
          value: 2015,
          normalizedValue: 2015,
          confidence: 0.95,
          sourceProvider: 'CrossRef',
          retrievedAt: new Date().toISOString(),
        },
      },
    };

    const decision = policy.reconcile([candidate1, candidate2]);
    expect(decision.proposedItem.title).toBe('Deep Learning Review');
    expect(decision.proposedItem.doi).toBe('10.1038/nature14539');
    expect(decision.selectedFields.title.sourceProvider).toBe('CrossRef');
    expect(decision.rejectedFields.title).toHaveLength(1);
    expect(decision.rejectedFields.title[0].sourceProvider).toBe('BibTeX');
  });

  it('detects metadata conflicts when candidates provide divergent high-confidence values', () => {
    const candidate1: MetadataCandidate = {
      candidateId: 'cand-1',
      sourceKind: 'PROVIDER',
      sourceName: 'CrossRef',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      confidenceScore: 0.9,
      normalizedMetadata: {
        title: 'Attention Is All You Need',
        year: 2017,
      },
      fields: {
        year: {
          path: 'year',
          value: 2017,
          normalizedValue: 2017,
          confidence: 0.9,
          sourceProvider: 'CrossRef',
          retrievedAt: new Date().toISOString(),
        },
      },
    };

    const candidate2: MetadataCandidate = {
      candidateId: 'cand-2',
      sourceKind: 'PROVIDER',
      sourceName: 'PubMed',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      confidenceScore: 0.9,
      normalizedMetadata: {
        title: 'Attention Is All You Need',
        year: 2023,
      },
      fields: {
        year: {
          path: 'year',
          value: 2023,
          normalizedValue: 2023,
          confidence: 0.9,
          sourceProvider: 'PubMed',
          retrievedAt: new Date().toISOString(),
        },
      },
    };

    const decision = policy.reconcile([candidate1, candidate2]);
    expect(decision.conflicts).toHaveLength(1);
    expect(decision.conflicts[0].field).toBe('year');
    expect(decision.conflicts[0].severity).toBe('high');
  });
});
