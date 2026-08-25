import { QueryClassifierUtil } from '@/modules/library/metadata/query-classifier.util';

describe('QueryClassifierUtil', () => {
  it('should correctly classify raw DOI strings', () => {
    const res1 = QueryClassifierUtil.classify('10.1145/3290605.3300233');
    expect(res1.type).toBe('DOI');
    expect(res1.clean).toBe('10.1145/3290605.3300233');

    const res2 = QueryClassifierUtil.classify(
      'https://doi.org/10.1038/s41586-020-2649-2',
    );
    expect(res2.type).toBe('DOI');
    expect(res2.clean).toBe('10.1038/s41586-020-2649-2');

    const res3 = QueryClassifierUtil.classify('doi: 10.5555/3295222');
    expect(res3.type).toBe('DOI');
    expect(res3.clean).toBe('10.5555/3295222');
  });

  it('should correctly classify arXiv identifiers and URLs', () => {
    const res1 = QueryClassifierUtil.classify('1706.03762');
    expect(res1.type).toBe('ARXIV');
    expect(res1.clean).toBe('1706.03762');

    const res2 = QueryClassifierUtil.classify('arxiv:1706.03762v5');
    expect(res2.type).toBe('ARXIV');
    expect(res2.clean).toBe('1706.03762v5');

    const res3 = QueryClassifierUtil.classify(
      'https://arxiv.org/abs/1706.03762',
    );
    expect(res3.type).toBe('ARXIV');
    expect(res3.clean).toBe('1706.03762');

    const res4 = QueryClassifierUtil.classify(
      'https://arxiv.org/pdf/1706.03762.pdf',
    );
    expect(res4.type).toBe('ARXIV');
    expect(res4.clean).toBe('1706.03762');
  });

  it('should classify paper titles', () => {
    const res = QueryClassifierUtil.classify('Attention Is All You Need');
    expect(res.type).toBe('TITLE');
    expect(res.clean).toBe('Attention Is All You Need');
  });
});
