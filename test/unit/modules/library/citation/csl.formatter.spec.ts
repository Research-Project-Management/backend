import { CslFormatter } from '@/modules/library/cite/formatters/csl.formatter';

describe('CslFormatter', () => {
  let formatter: CslFormatter;

  beforeEach(() => {
    formatter = new CslFormatter();
  });

  const samplePaper = {
    id: 'p1',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki'],
    year: 2017,
    journal: 'Advances in Neural Information Processing Systems',
    volume: '30',
    pages: '5998-6008',
    doi: '10.48550/arXiv.1706.03762',
  };

  it('should format in APA 7th Edition style', () => {
    const res = formatter.formatEntry(samplePaper, 'apa');

    expect(res.style).toBe('apa');
    expect(res.inText).toBe('(Vaswani et al., 2017)');
    expect(res.bibliography).toContain(
      'Vaswani, A., Shazeer, N., & Parmar, N. (2017). Attention Is All You Need.',
    );
    expect(res.bibliography).toContain(
      'Advances in Neural Information Processing Systems, 30, 5998-6008.',
    );
    expect(res.bibliographyHtml).toContain(
      '<i>Advances in Neural Information Processing Systems</i>',
    );
  });

  it('should format in IEEE style', () => {
    const res = formatter.formatEntry(samplePaper, 'ieee', 1);

    expect(res.style).toBe('ieee');
    expect(res.inText).toBe('[1]');
    expect(res.bibliography).toContain(
      '[1] A. Vaswani, N. Shazeer, and N. Parmar, "Attention Is All You Need,"',
    );
    expect(res.bibliography).toContain('vol. 30, pp. 5998-6008, 2017.');
  });

  it('should format in Nature style', () => {
    const res = formatter.formatEntry(samplePaper, 'nature');

    expect(res.style).toBe('nature');
    expect(res.inText).toBe('Vaswani et al. (2017)');
    expect(res.bibliography).toContain(
      'Vaswani, A., Shazeer, N., Parmar, N. Attention Is All You Need. Advances in Neural Information Processing Systems 30, 5998-6008 (2017).',
    );
  });

  it('should format in Harvard style', () => {
    const res = formatter.formatEntry(samplePaper, 'harvard');

    expect(res.style).toBe('harvard');
    expect(res.inText).toBe('(Vaswani et al., 2017)');
    expect(res.bibliography).toContain(
      'Vaswani, A., Shazeer, N. and Parmar, N., 2017. Attention Is All You Need.',
    );
  });

  it('should format in Chicago style', () => {
    const res = formatter.formatEntry(samplePaper, 'chicago');

    expect(res.style).toBe('chicago');
    expect(res.inText).toBe('(Vaswani et al. 2017)');
    expect(res.bibliography).toContain(
      'Vaswani, Ashish, Noam Shazeer, and Niki Parmar. 2017. "Attention Is All You Need."',
    );
  });

  it('should format in MLA 9th style', () => {
    const res = formatter.formatEntry(samplePaper, 'mla');

    expect(res.style).toBe('mla');
    expect(res.inText).toBe('(Vaswani et al.)');
    expect(res.bibliography).toContain(
      'Vaswani, Ashish, et al. "Attention Is All You Need."',
    );
  });

  it('should format in Vancouver style', () => {
    const res = formatter.formatEntry(samplePaper, 'vancouver', 1);

    expect(res.style).toBe('vancouver');
    expect(res.inText).toBe('(1)');
    expect(res.bibliography).toContain(
      '1. Vaswani A, Shazeer N, Parmar N. Attention Is All You Need.',
    );
  });

  it('should transform paper to standard CSL-JSON item structure', () => {
    const csl = formatter.toCslJson({
      id: 'paper-123',
      title: 'Attention Is All You Need.',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      year: 2017,
      journal: 'NeurIPS',
      publisher: 'Curran Associates',
      place: 'Long Beach, CA',
      volume: '30',
      pages: '5998-6008',
      doi: '10.48550/arXiv.1706.03762',
      itemType: 'conferencePaper',
      extra: 'PMCID: PMC123456',
    });

    expect(csl.id).toBe('paper-123');
    expect(csl.type).toBe('paper-conference');
    expect(csl.title).toBe('Attention Is All You Need');
    expect(csl.author).toEqual([
      { family: 'Vaswani', given: 'Ashish' },
      { family: 'Shazeer', given: 'Noam' },
    ]);
    expect(csl.issued).toEqual({ 'date-parts': [[2017]] });
    expect(csl['container-title']).toBe('NeurIPS');
    expect(csl.publisher).toBe('Curran Associates');
    expect(csl['publisher-place']).toBe('Long Beach, CA');
    expect(csl.volume).toBe('30');
    expect(csl.page).toBe('5998-6008');
    expect(csl.DOI).toBe('10.48550/arXiv.1706.03762');
    expect(csl.note).toBe('PMCID: PMC123456');
  });
});
