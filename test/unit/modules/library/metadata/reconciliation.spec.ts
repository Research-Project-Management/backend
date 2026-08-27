import { ReconciliationService } from '@/modules/library/legacy/metadata/reconciliation.service';
import { MetadataCandidate } from '@/modules/library/legacy/metadata/types/metadata.types';

describe('ReconciliationService (Provenance & Field-Level Assertions)', () => {
  let service: ReconciliationService;

  beforeEach(() => {
    service = new ReconciliationService();
  });

  const crossrefCandidate: MetadataCandidate = {
    id: 'cand-cr',
    sourceProvider: 'CrossRef',
    confidenceScore: 0.95,
    fetchedAt: new Date().toISOString(),
    metadata: {
      doi: '10.1038/nature12345',
      title: 'Attention Is All You Need (Published)',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      year: 2017,
      itemType: 'journalArticle',
      journal: 'Nature Machine Intelligence',
      publisher: 'Nature Publishing Group',
    },
  };

  const arxivCandidate: MetadataCandidate = {
    id: 'cand-arxiv',
    sourceProvider: 'arXiv',
    confidenceScore: 0.92,
    fetchedAt: new Date().toISOString(),
    metadata: {
      arxivId: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
      year: 2017,
      itemType: 'preprint',
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      openAccessPdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
    },
  };

  const semanticScholarCandidate: MetadataCandidate = {
    id: 'cand-s2',
    sourceProvider: 'SemanticScholar',
    confidenceScore: 0.9,
    fetchedAt: new Date().toISOString(),
    metadata: {
      title: 'Attention Is All You Need',
      authors: ['A. Vaswani', 'N. Shazeer'],
      year: 2017,
      itemType: 'conferencePaper',
      citationCount: 95000,
      tldr: 'Transformers replace RNNs and CNNs entirely with self-attention mechanisms.',
    },
  };

  it('reconciles multiple candidates selecting the highest-weighted authority per field', () => {
    const result = service.reconcile([
      crossrefCandidate,
      arxivCandidate,
      semanticScholarCandidate,
    ]);

    expect(result.metadata.doi).toBe('10.1038/nature12345');
    expect(result.metadata.arxivId).toBe('1706.03762');
    // Journal: CrossRef has higher authority
    expect(result.metadata.journal).toBe('Nature Machine Intelligence');
    // Abstract: arXiv has higher authority than CrossRef
    expect(result.metadata.abstract).toContain(
      'The dominant sequence transduction models',
    );
    // Citation count: SemanticScholar
    expect(result.metadata.citationCount).toBe(95000);
    // TLDR: SemanticScholar
    expect(result.metadata.tldr).toContain('Transformers replace RNNs');
    // OA PDF: arXiv
    expect(result.metadata.openAccessPdfUrl).toBe(
      'https://arxiv.org/pdf/1706.03762.pdf',
    );

    // Assertions check
    expect(result.assertions.length).toBeGreaterThan(5);
    const abstractAssertion = result.assertions.find(
      (a) => a.field === 'abstract',
    );
    expect(abstractAssertion?.sourceProvider).toBe('arXiv');
  });

  it('protects user overrides with absolute priority (UserOverride: 1.0)', () => {
    const result = service.reconcile([crossrefCandidate, arxivCandidate], {
      title: 'Custom User Title For Transformers',
      year: 2018,
    });

    expect(result.metadata.title).toBe('Custom User Title For Transformers');
    expect(result.metadata.year).toBe(2018);

    const titleAssertion = result.assertions.find((a) => a.field === 'title');
    expect(titleAssertion?.sourceProvider).toBe('UserOverride');
    expect(titleAssertion?.isUserOverride).toBe(true);
  });

  it('detects metadata conflicts when high-confidence sources disagree on publication year', () => {
    const divergentYearCandidate: MetadataCandidate = {
      id: 'cand-s2-divergent',
      sourceProvider: 'SemanticScholar',
      confidenceScore: 0.9,
      fetchedAt: new Date().toISOString(),
      metadata: {
        title: 'Attention Is All You Need',
        authors: ['Vaswani'],
        year: 2021, // 4 years divergence from CrossRef 2017
        itemType: 'journalArticle',
      },
    };

    const result = service.reconcile([
      crossrefCandidate,
      divergentYearCandidate,
    ]);

    expect(result.conflictReport.hasConflicts).toBe(true);
    const yearConflict = result.conflictReport.conflicts.find(
      (c) => c.field === 'year',
    );
    expect(yearConflict).toBeDefined();
    expect(yearConflict?.description).toContain('2017 vs 2021');
  });

  it('returns fallback metadata when candidates list is empty', () => {
    const result = service.reconcile([], { title: 'User Draft' });
    expect(result.metadata.title).toBe('User Draft');
    expect(result.assertions).toEqual([]);
    expect(result.conflictReport.hasConflicts).toBe(false);
  });
});
