/**
 * Parity tests: canonical and legacy identifier normalizers must produce identical output.
 *
 * These tests pin the contract that the canonical re-export layer produces exactly
 * the same results as importing directly from Legacy — ensuring no divergence
 * if either side is updated in the future.
 */
import {
  normalizeDoi as canonicalNormalizeDoi,
  normalizeArxivId as canonicalNormalizeArxivId,
  normalizePmid as canonicalNormalizePmid,
  normalizeIsbn as canonicalNormalizeIsbn,
} from '@/modules/library/ingestion/metadata/metadata.identifiers';

import {
  normalizeDoi as legacyNormalizeDoi,
  normalizeArxivId as legacyNormalizeArxivId,
  normalizePmid as legacyNormalizePmid,
  normalizeIsbn as legacyNormalizeIsbn,
} from '@/modules/library/legacy/metadata/utils/metadata.util';

import {
  QueryClassifier as CanonicalQC,
} from '@/modules/library/ingestion/metadata/metadata.classifier';

import {
  QueryClassifierUtil as LegacyQC,
} from '@/modules/library/legacy/metadata/utils/metadata.util';

const DOI_FIXTURES = [
  '10.1234/foo',
  'doi:10.1234/foo',
  'https://doi.org/10.1038/s41586-020-2649-2',
  'https://dx.doi.org/10.5555/12345',
  '10.1000/xyz123.',
  'not-a-doi',
  '',
  null,
  undefined,
];

const ARXIV_FIXTURES = [
  '1706.03762',
  'arxiv:1706.03762v5',
  'https://arxiv.org/abs/1706.03762',
  'https://arxiv.org/pdf/2106.01234.pdf',
  'not-arxiv',
  '',
];

const PMID_FIXTURES = ['12345678', 'pmid:12345', 'https://pubmed.ncbi.nlm.nih.gov/12345/', 'abc', ''];

const ISBN_FIXTURES = ['9780316769174', '978-0-316-76917-4', 'isbn:9780316769174', 'abc', ''];

describe('Canonical ↔ Legacy parity — identifier normalizers', () => {
  DOI_FIXTURES.forEach((doi) => {
    it(`normalizeDoi("${doi}"): canonical === legacy`, () => {
      expect(canonicalNormalizeDoi(doi as any)).toBe(legacyNormalizeDoi(doi as any));
    });
  });

  ARXIV_FIXTURES.forEach((arxiv) => {
    it(`normalizeArxivId("${arxiv}"): canonical === legacy`, () => {
      expect(canonicalNormalizeArxivId(arxiv)).toBe(legacyNormalizeArxivId(arxiv));
    });
  });

  PMID_FIXTURES.forEach((pmid) => {
    it(`normalizePmid("${pmid}"): canonical === legacy`, () => {
      expect(canonicalNormalizePmid(pmid)).toBe(legacyNormalizePmid(pmid));
    });
  });

  ISBN_FIXTURES.forEach((isbn) => {
    it(`normalizeIsbn("${isbn}"): canonical === legacy`, () => {
      expect(canonicalNormalizeIsbn(isbn)).toBe(legacyNormalizeIsbn(isbn));
    });
  });
});

describe('Canonical ↔ Legacy parity — QueryClassifier', () => {
  const QUERY_FIXTURES = [
    '10.1145/3290605.3300233',
    'doi:10.1038/s41586-020-2649-2',
    '1706.03762',
    'arxiv:1706.03762v5',
    'https://arxiv.org/abs/1706.03762',
    '12345678',
    'https://pubmed.ncbi.nlm.nih.gov/12345678/',
    '9780316769174',
    'https://www.nature.com/articles/foo',
    'Attention Is All You Need',
  ];

  QUERY_FIXTURES.forEach((q) => {
    it(`classify("${q}"): canonical === legacy`, () => {
      const canonical = CanonicalQC.classify(q);
      const legacy = LegacyQC.classify(q);
      expect(canonical).toEqual(legacy);
    });
  });
});
