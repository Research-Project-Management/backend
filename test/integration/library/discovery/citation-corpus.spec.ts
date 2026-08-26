/* eslint-disable @typescript-eslint/no-require-imports */
import { CitationService } from '../../../../src/contexts/library/citation/citation.service';

const goldenCorpus = require('../../../fixtures/library/citation-golden-corpus.json');


describe('CSL Style Registry & Golden Citation Corpus (Integration)', () => {
  let citationService: CitationService;

  beforeAll(() => {
    citationService = new CitationService();
  });

  it('formats APA 7th edition citations matching golden expectations', () => {
    const apaStyle = goldenCorpus.styles.find(
      (s: any) => s.styleId === 'apa-7th',
    );
    const testCase = apaStyle.testCases[0];
    const res = citationService.formatItem(testCase.input, 'apa-7th');

    expect(res.inText).toBe(testCase.expectedInText);
    expect(res.bibliography).toContain('Vaswani, A.');
    expect(res.bibliography).toContain('Attention is all you need.');
    expect(res.bibliography).toContain(
      'https://doi.org/10.48550/arXiv.1706.03762',
    );
  });

  it('formats IEEE citations matching golden expectations', () => {
    const ieeeStyle = goldenCorpus.styles.find(
      (s: any) => s.styleId === 'ieee',
    );
    const testCase = ieeeStyle.testCases[0];
    const res = citationService.formatItem(testCase.input, 'ieee', 1);

    expect(res.inText).toBe(testCase.expectedInText);
    expect(res.bibliography).toContain('K. He');
    expect(res.bibliography).toContain(
      '"Deep Residual Learning for Image Recognition,"',
    );
    expect(res.bibliography).toContain('2016');
  });

  it('formats Nature citations matching golden expectations', () => {
    const natureStyle = goldenCorpus.styles.find(
      (s: any) => s.styleId === 'nature',
    );
    const testCase = natureStyle.testCases[0];
    const res = citationService.formatItem(testCase.input, 'nature', 1);

    expect(res.inText).toBe(testCase.expectedInText);
    expect(res.bibliography).toContain('Silver, D.');
    expect(res.bibliography).toContain('Mastering the game of Go');
  });

  it('formats BibTeX entries matching syntax', () => {
    const apaStyle = goldenCorpus.styles.find(
      (s: any) => s.styleId === 'apa-7th',
    );
    const testCase = apaStyle.testCases[0];
    const res = citationService.formatItem(
      { ...testCase.input, citationKey: 'vaswani2017attention' },
      'bibtex',
    );

    expect(res.inText).toBe('\\cite{vaswani2017attention}');
    expect(res.bibliography).toContain('@article{vaswani2017attention,');
    expect(res.bibliography).toContain('title = {Attention is all you need}');
  });

  it('formats RIS entries matching syntax', () => {
    const ieeeStyle = goldenCorpus.styles.find(
      (s: any) => s.styleId === 'ieee',
    );
    const testCase = ieeeStyle.testCases[0];
    const res = citationService.formatItem(testCase.input, 'ris');

    expect(res.bibliography).toContain('TY  - JOUR');
    expect(res.bibliography).toContain(
      'TI  - Deep Residual Learning for Image Recognition',
    );
    expect(res.bibliography).toContain('AU  - He, Kaiming');
    expect(res.bibliography).toContain('ER  -');
  });
});
