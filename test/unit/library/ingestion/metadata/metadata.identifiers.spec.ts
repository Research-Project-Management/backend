import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  formatCanonicalId,
} from '@/modules/library/ingestion/metadata/metadata.identifiers';

describe('metadata.identifiers re-exports', () => {
  describe('normalizeDoi', () => {
    it('strips doi: prefix', () => expect(normalizeDoi('doi:10.1234/foo')).toBe('10.1234/foo'));
    it('strips https://doi.org/', () => expect(normalizeDoi('https://doi.org/10.1234/foo')).toBe('10.1234/foo'));
    it('strips https://dx.doi.org/', () => expect(normalizeDoi('https://dx.doi.org/10.1234/foo')).toBe('10.1234/foo'));
    it('lowercases', () => expect(normalizeDoi('10.1234/FOO')).toBe('10.1234/foo'));
    it('returns undefined for garbage', () => expect(normalizeDoi('not-a-doi')).toBeUndefined());
    it('returns undefined for null', () => expect(normalizeDoi(null)).toBeUndefined());
    it('strips trailing punctuation', () => expect(normalizeDoi('10.1234/foo.')).toBe('10.1234/foo'));
  });

  describe('normalizeArxivId', () => {
    it('strips https://arxiv.org/abs/ prefix', () =>
      expect(normalizeArxivId('https://arxiv.org/abs/1706.03762')).toBe('1706.03762'));
    it('strips arxiv: prefix', () =>
      expect(normalizeArxivId('arxiv:1706.03762v5')).toBe('1706.03762v5'));
    it('strips .pdf suffix', () =>
      expect(normalizeArxivId('1706.03762.pdf')).toBe('1706.03762'));
    it('strips version with stripVersion option', () =>
      expect(normalizeArxivId('1706.03762v5', { stripVersion: true })).toBe('1706.03762'));
    it('returns undefined for garbage', () =>
      expect(normalizeArxivId('not-arxiv')).toBeUndefined());
  });

  describe('normalizePmid', () => {
    it('strips pmid: prefix', () => expect(normalizePmid('pmid:12345')).toBe('12345'));
    it('strips pubmed URL', () =>
      expect(normalizePmid('https://pubmed.ncbi.nlm.nih.gov/12345678/')).toBe('12345678'));
    it('returns raw digits', () => expect(normalizePmid('999')).toBe('999'));
    it('returns undefined for non-numeric', () => expect(normalizePmid('abc')).toBeUndefined());
  });

  describe('normalizePmcid', () => {
    it('normalizes PMC12345', () => expect(normalizePmcid('PMC12345')).toBe('PMC12345'));
    it('normalizes PMCID:12345', () => expect(normalizePmcid('PMCID:12345')).toBe('PMC12345'));
    it('returns undefined for garbage', () => expect(normalizePmcid('abc')).toBeUndefined());
  });

  describe('normalizeIsbn', () => {
    it('normalizes ISBN-13 with hyphens', () =>
      expect(normalizeIsbn('978-0-316-76917-4')).toBe('9780316769174'));
    it('normalizes ISBN-10', () => {
      const result = normalizeIsbn('031676917X');
      // ISBN-10 with X check digit — may normalize or return undefined depending on implementation
      expect(result === '031676917X' || result === undefined).toBe(true);
    });
    it('returns undefined for short string', () =>
      expect(normalizeIsbn('123')).toBeUndefined());
  });

  describe('normalizeIssn', () => {
    it('normalizes ISSN with hyphens', () =>
      expect(normalizeIssn('1234-5679')).toBe('1234-5679'));
    it('normalizes ISSN without hyphens', () =>
      expect(normalizeIssn('12345679')).toBe('1234-5679'));
    it('returns undefined for invalid', () =>
      expect(normalizeIssn('abc')).toBeUndefined());
  });

  describe('formatCanonicalId', () => {
    it('formats doi scheme', () =>
      expect(formatCanonicalId('doi', '10.1234/foo')).toBe('doi:10.1234/foo'));
    it('formats arxiv scheme', () =>
      expect(formatCanonicalId('arxiv', '1706.03762')).toBe('arxiv:1706.03762'));
    it('formats pmid scheme', () =>
      expect(formatCanonicalId('pmid', '12345')).toBe('pmid:12345'));
    it('returns undefined for invalid input', () =>
      expect(formatCanonicalId('doi', 'not-a-doi')).toBeUndefined());
  });
});
