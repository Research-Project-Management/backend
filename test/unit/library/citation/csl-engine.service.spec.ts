import { CslEngineService } from '../../../../src/modules/library/citation/services/csl-engine.service';
import { CslItemData } from '../../../../src/modules/library/citation/types/csl-json.types';

describe('CslEngineService (Unit)', () => {
  let service: CslEngineService;

  beforeAll(() => {
    service = new CslEngineService();
    service.initTemplates();
  });

  const testPaper: CslItemData = {
    id: 'preskill2021',
    type: 'article-journal',
    title: 'Quantum Computing in the NISQ Era and Beyond',
    author: [{ family: 'Preskill', given: 'John' }],
    'container-title': 'Quantum',
    volume: '5',
    page: '79',
    issued: { 'date-parts': [[2021]] },
    DOI: '10.22331/q-2021-02-05-422',
  };

  it('formats APA 7th edition citation and bibliography adhering to CSL specs', () => {
    const res = service.format(testPaper, 'apa');
    expect(res.styleId).toBe('apa');
    expect(res.bibliography).toContain('Preskill, J.');
    expect(res.bibliography).toContain('Quantum');
    expect(res.bibliography).toContain('(2021)');
    expect(res.inText).toBe('(Preskill, 2021)');
    expect(res.bibliographyHtml).toContain('class="csl-entry"');
  });

  it('formats IEEE style with bracketed numbers and abbreviation', () => {
    const res = service.format(testPaper, 'ieee', 1);
    expect(res.styleId).toBe('ieee');
    expect(res.bibliography).toContain('J. Preskill');
    expect(res.bibliography).toContain('vol. 5');
    expect(res.bibliography).toContain('[1]');
  });

  it('formats Nature style correctly', () => {
    const res = service.format(testPaper, 'nature', 1);
    expect(res.styleId).toBe('nature');
    expect(res.bibliography).toContain('Preskill, J.');
    expect(res.bibliography).toContain('(2021)');
  });

  it('formats Chicago Author-Date style correctly', () => {
    const res = service.format(testPaper, 'chicago');
    expect(res.styleId).toBe('chicago');
    expect(res.bibliography).toContain('Preskill, John. 2021.');
  });

  it('formats MLA style correctly', () => {
    const res = service.format(testPaper, 'mla');
    expect(res.styleId).toBe('mla');
    expect(res.bibliography).toContain('Preskill, John.');
  });

  it('formats BibTeX with LaTeX character escaping and title protection', () => {
    const paperWithSpecialChars: CslItemData = {
      id: 'smith2020',
      type: 'article-journal',
      title: 'Machine Learning & AI: A 50% Reduction in Errors',
      author: [{ family: 'Smith', given: 'Alice' }],
      'container-title': 'Nature Machine Intelligence',
      issued: { 'date-parts': [[2020]] },
    };

    const res = service.format(paperWithSpecialChars, 'bibtex');
    expect(res.styleId).toBe('bibtex');
    expect(res.bibliography).toContain('@article');
    // Verify LaTeX characters are properly escaped
    expect(res.bibliography).toMatch(/\\&/);
    expect(res.bibliography).toMatch(/\\%/);
  });

  it('formats RIS with standard tags', () => {
    const res = service.format(testPaper, 'ris');
    expect(res.styleId).toBe('ris');
    expect(res.bibliography).toContain('TY  - JOUR');
    expect(res.bibliography).toContain('AU  - Preskill, John');
    expect(res.bibliography).toContain('PY  - 2021');
    expect(res.bibliography).toContain('ER  -');
  });

  it('formats a batch of items', () => {
    const batchRes = service.formatBatch([testPaper], 'apa');
    expect(batchRes.citations.length).toBe(1);
    expect(batchRes.bibliographyText).toContain('Preskill');
  });
});
