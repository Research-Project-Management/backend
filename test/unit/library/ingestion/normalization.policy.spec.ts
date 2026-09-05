import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';

describe('NormalizationPolicy', () => {
  let policy: NormalizationPolicy;

  beforeEach(() => {
    policy = new NormalizationPolicy();
  });

  it('strips "undefined", "null", empty strings and banned placeholders', () => {
    const raw = {
      title: '  Valid Paper Title  ',
      abstract: 'undefined',
      doi: 'null',
      publisher: 'N/A',
      journal: 'none',
      volume: '',
    };

    const normalized = policy.normalize(raw);
    expect(normalized.title).toBe('Valid Paper Title');
    expect(normalized.abstract).toBeUndefined();
    expect(normalized.doi).toBeUndefined();
    expect(normalized.publisher).toBeUndefined();
    expect(normalized.publicationTitle).toBeUndefined();
    expect(normalized.volume).toBeUndefined();
  });

  it('normalizes DOI and dates correctly', () => {
    const raw = {
      title: '{Quantum computing in 2024}',
      doi: 'https://doi.org/10.1038/s41586-020-2003-4',
      publicationDate: '2024-05-12',
      year: 2024,
    };

    const normalized = policy.normalize(raw);
    expect(normalized.title).toBe('Quantum computing in 2024');
    expect(normalized.doi).toBe('10.1038/s41586-020-2003-4');
    expect(normalized.year).toBe(2024);
  });

  it('cleans tags and normalizes creators', () => {
    const raw = {
      title: 'Sample Paper',
      tags: ['#AI', '##machine-learning', 'AI', 'undefined', ''],
      authors: ['Turing, Alan', 'Church, Alonzo'],
    };

    const normalized = policy.normalize(raw);
    expect(normalized.tags).toEqual(['ai', 'machine-learning']);
    expect(normalized.creators).toEqual([
      {
        creatorType: 'author',
        name: 'Alan Turing',
        firstName: 'Alan',
        lastName: 'Turing',
      },
      {
        creatorType: 'author',
        name: 'Alonzo Church',
        firstName: 'Alonzo',
        lastName: 'Church',
      },
    ]);
  });

  it('retains publication, identifier, metric, and attachment metadata', () => {
    const normalized = policy.normalize({
      title: 'Complete record',
      pmcid: 'PMCID: PMC1234567',
      date: '2026-09-04',
      journalAbbr: 'J Complete Rec',
      section: 'Research',
      partNumber: 'II',
      seriesNumber: '8',
      abstractNote: 'Imported abstract note',
      tldr: 'Short finding',
      referenceCount: 42,
      influentialCitationCount: 4,
      openAccessPdfUrl: 'https://example.test/open.pdf',
      archiveLocation: 'ia:complete-record',
      editors: ['Grace Hopper'],
    });

    expect(normalized).toMatchObject({
      pmcid: 'PMC1234567',
      date: '2026-09-04',
      journalAbbr: 'J Complete Rec',
      section: 'Research',
      partNumber: 'II',
      seriesNumber: '8',
      abstract: 'Imported abstract note',
      abstractNote: 'Imported abstract note',
      tldr: 'Short finding',
      referenceCount: 42,
      influentialCitationCount: 4,
      openAccessPdfUrl: 'https://example.test/open.pdf',
      archiveLocation: 'ia:complete-record',
      editors: ['Grace Hopper'],
    });
  });

  it('keeps authors and editors when providers supply them separately', () => {
    const normalized = policy.normalize({
      creators: [{ creatorType: 'editor', name: 'Grace Hopper' }],
      authors: ['Ada Lovelace'],
      editors: ['Grace Hopper'],
    });

    expect(normalized.creators).toEqual([
      { creatorType: 'editor', name: 'Grace Hopper' },
      { creatorType: 'author', name: 'Ada Lovelace' },
    ]);
    expect(normalized.authors).toEqual(['Ada Lovelace']);
  });
});
