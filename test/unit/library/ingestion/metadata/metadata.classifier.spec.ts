/**
 * Tests for metadata.classifier.ts re-export.
 * Ensures the canonical import path resolves correctly and the classifier
 * works identically to the legacy import path (parity check via re-export).
 */
import {
  QueryClassifier,
  QueryClassifierUtil,
} from '@/modules/library/ingestion/metadata/metadata.classifier';

describe('Canonical metadata.classifier re-export', () => {
  describe('DOI classification', () => {
    it('classifies bare DOI string', () => {
      const r = QueryClassifier.classify('10.1145/3290605.3300233');
      expect(r.type).toBe('DOI');
      expect(r.clean).toBe('10.1145/3290605.3300233');
    });

    it('classifies doi.org URL', () => {
      const r = QueryClassifier.classify(
        'https://doi.org/10.1038/s41586-020-2649-2',
      );
      expect(r.type).toBe('DOI');
      expect(r.clean).toBe('10.1038/s41586-020-2649-2');
    });

    it('classifies doi: prefix with space', () => {
      const r = QueryClassifier.classify('doi: 10.5555/3295222');
      expect(r.type).toBe('DOI');
      expect(r.clean).toBe('10.5555/3295222');
    });
  });

  describe('arXiv classification', () => {
    it('classifies bare arXiv ID', () => {
      const r = QueryClassifier.classify('1706.03762');
      expect(r.type).toBe('ARXIV');
      expect(r.clean).toBe('1706.03762');
    });

    it('classifies arxiv: prefix with version', () => {
      const r = QueryClassifier.classify('arxiv:1706.03762v5');
      expect(r.type).toBe('ARXIV');
      expect(r.clean).toBe('1706.03762v5');
    });

    it('classifies arXiv abs URL', () => {
      const r = QueryClassifier.classify('https://arxiv.org/abs/1706.03762');
      expect(r.type).toBe('ARXIV');
      expect(r.clean).toBe('1706.03762');
    });

    it('classifies arXiv pdf URL', () => {
      const r = QueryClassifier.classify(
        'https://arxiv.org/pdf/1706.03762.pdf',
      );
      expect(r.type).toBe('ARXIV');
      expect(r.clean).toBe('1706.03762');
    });
  });

  describe('PMID classification', () => {
    it('classifies bare PMID', () => {
      const r = QueryClassifier.classify('12345678');
      expect(r.type).toBe('PMID');
      expect(r.clean).toBe('12345678');
    });

    it('classifies PubMed URL', () => {
      const r = QueryClassifier.classify(
        'https://pubmed.ncbi.nlm.nih.gov/12345678/',
      );
      expect(r.type).toBe('PMID');
      expect(r.clean).toBe('12345678');
    });
  });

  describe('ISBN classification', () => {
    it('classifies ISBN-13', () => {
      const r = QueryClassifier.classify('9780316769174');
      expect(r.type).toBe('ISBN');
      expect(r.clean).toBe('9780316769174');
    });

    it('classifies isbn: prefixed', () => {
      const r = QueryClassifier.classify('isbn:9780316769174');
      expect(r.type).toBe('ISBN');
    });
  });

  describe('URL classification', () => {
    it('classifies generic https URL', () => {
      const r = QueryClassifier.classify(
        'https://nature.com/articles/some-paper',
      );
      expect(r.type).toBe('URL');
    });
  });

  describe('TITLE classification', () => {
    it('classifies paper title', () => {
      const r = QueryClassifier.classify('Attention Is All You Need');
      expect(r.type).toBe('TITLE');
      expect(r.clean).toBe('Attention Is All You Need');
    });

    it('empty string returns TITLE type', () => {
      const r = QueryClassifier.classify('');
      expect(r.type).toBe('TITLE');
    });
  });

  it('QueryClassifierUtil is aliased correctly', () => {
    expect(QueryClassifierUtil).toBe(QueryClassifier);
  });
});
