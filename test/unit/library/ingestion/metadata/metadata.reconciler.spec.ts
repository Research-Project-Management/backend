import { MetadataReconciliationService } from '@/modules/library/ingestion/metadata/metadata.reconciler';

describe('MetadataReconciliationService (Canonical)', () => {
  let reconciler: MetadataReconciliationService;

  beforeEach(() => {
    reconciler = new MetadataReconciliationService();
  });

  it('is instantiable without dependencies', () => {
    expect(reconciler).toBeDefined();
  });

  it('reconcile returns metadata and assertions without mutating inputs', () => {
    const candidateMeta = {
      title: 'Canonical Title',
      authors: ['Author A'],
      year: 2024,
      doi: '10.1234/foo',
    };
    const candidates = [
      {
        id: 'crossref:10.1234/foo',
        sourceProvider: 'CrossRef',
        metadata: candidateMeta,
        confidenceScore: 0.99,
        fetchedAt: new Date().toISOString(),
      },
    ];
    const result = reconciler.reconcile(candidates);
    expect(result.metadata.title).toBe('Canonical Title');
    expect(result.assertions).toBeDefined();
    expect(Array.isArray(result.assertions)).toBe(true);

    // Verify immutability
    expect(result.metadata).not.toBe(candidateMeta);
  });

  it('high-authority provider wins over low-authority for same field', () => {
    const candidates = [
      {
        id: 's2:1',
        sourceProvider: 'SemanticScholar',
        metadata: { title: 'S2 Title', doi: '10.1/x', authors: [] },
        confidenceScore: 0.88,
        fetchedAt: new Date().toISOString(),
      },
      {
        id: 'crossref:1',
        sourceProvider: 'CrossRef',
        metadata: { title: 'CrossRef Title', doi: '10.1/x', authors: [] },
        confidenceScore: 0.99,
        fetchedAt: new Date().toISOString(),
      },
    ];
    const result = reconciler.reconcile(candidates);
    expect(result.metadata.title).toBe('CrossRef Title');
  });

  it('null value from one provider does NOT overwrite good value from another', () => {
    const candidates = [
      {
        id: 'crossref:1',
        sourceProvider: 'CrossRef',
        metadata: { title: 'Good Title', doi: '10.1/x', authors: ['A'], year: 2022 },
        confidenceScore: 0.99,
        fetchedAt: new Date().toISOString(),
      },
      {
        id: 's2:1',
        sourceProvider: 'SemanticScholar',
        metadata: { title: 'Good Title', doi: '10.1/x', authors: [], year: null },
        confidenceScore: 0.88,
        fetchedAt: new Date().toISOString(),
      },
    ];
    const result = reconciler.reconcile(candidates);
    expect(result.metadata.year).toBe(2022);
  });

  it('single candidate returns its data as-is', () => {
    const candidates = [
      {
        id: 'arxiv:1706.03762',
        sourceProvider: 'arXiv',
        metadata: { title: 'Attention Is All You Need', authors: ['Vaswani'], year: 2017 },
        confidenceScore: 0.95,
        fetchedAt: new Date().toISOString(),
      },
    ];
    const result = reconciler.reconcile(candidates);
    expect(result.metadata.title).toBe('Attention Is All You Need');
    expect(result.metadata.year).toBe(2017);
  });
});
