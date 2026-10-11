/**
 * Unit tests for `inferItemTypeFromPdfSignals` — the heuristic itemType
 * inference function used when a PDF upload has no DOI, arXiv ID, or other
 * authoritative identifier.
 *
 * @see src/modules/library/shared-kernel/utils/bibliographic.utils.ts
 */
import { inferItemTypeFromPdfSignals } from '@/modules/library/shared-kernel/utils/bibliographic.utils';

describe('inferItemTypeFromPdfSignals', () => {
  // ──────────────────────────────────────────────────────────────
  // Tier 1 – ISBN
  // ──────────────────────────────────────────────────────────────
  describe('Tier 1 – ISBN present', () => {
    it('returns book when ISBN is present without bookTitle', () => {
      const result = inferItemTypeFromPdfSignals({ isbn: '9780262035613' });
      expect(result?.itemType).toBe('book');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('returns bookSection when ISBN + bookTitle are both present', () => {
      const result = inferItemTypeFromPdfSignals({
        isbn: '9780262035613',
        bookTitle: 'Advances in Machine Learning',
      });
      expect(result?.itemType).toBe('bookSection');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 2 – Native structural signals
  // ──────────────────────────────────────────────────────────────
  describe('Tier 2 – Native structural signals', () => {
    it('returns conferencePaper when conferenceName is present', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Attention Is All You Need',
        conferenceName: 'NeurIPS 2017',
      });
      expect(result?.itemType).toBe('conferencePaper');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('returns bookSection when bookTitle is present', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Introduction to Probability',
        bookTitle: 'Handbook of Statistics',
      });
      expect(result?.itemType).toBe('bookSection');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 3a – Thesis patterns
  // ──────────────────────────────────────────────────────────────
  describe('Tier 3a – Thesis patterns', () => {
    it('detects PhD thesis from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Deep Learning Approaches: A PhD Thesis',
      });
      expect(result?.itemType).toBe('thesis');
    });

    it('detects master thesis from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: "Master's Dissertation on Quantum Computing",
      });
      expect(result?.itemType).toBe('thesis');
    });

    it('detects thesis from submission note', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Scalable Distributed Systems',
        notes: [
          {
            content:
              'Submitted in partial fulfilment for the degree of Doctor of Philosophy',
          },
        ],
      });
      expect(result?.itemType).toBe('thesis');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('detects thesis when "for the degree of" appears in notes', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'A Study of Neural Networks',
        notes: [
          'submitted to the Graduate School for the degree of Master of Science',
        ],
      });
      expect(result?.itemType).toBe('thesis');
    });

    it('falls back to filename thesis detection', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Scalable Systems',
        filename: 'john_doe_phd_thesis_2023.pdf',
      });
      expect(result?.itemType).toBe('thesis');
      expect(result?.confidence).toBeLessThan(0.8); // tier-4 is lower confidence
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 3b – Report patterns
  // ──────────────────────────────────────────────────────────────
  describe('Tier 3b – Report patterns', () => {
    it('detects technical report from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Performance Analysis: A Technical Report',
      });
      expect(result?.itemType).toBe('report');
    });

    it('detects whitepaper from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Blockchain Technology White Paper',
      });
      expect(result?.itemType).toBe('report');
    });

    it('detects report from NIST/NASA note', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Cryptographic Standards',
        notes: ['NIST Special Publication 800-38'],
      });
      expect(result?.itemType).toBe('report');
    });

    it('detects report from filename', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Security Assessment',
        filename: 'security-techreport-2024.pdf',
      });
      expect(result?.itemType).toBe('report');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 3c – Conference paper patterns (title/note)
  // ──────────────────────────────────────────────────────────────
  describe('Tier 3c – Conference paper patterns', () => {
    it('detects conference paper from "Proceedings of" in title', () => {
      const result = inferItemTypeFromPdfSignals({
        title:
          'Proceedings of the International Conference on Machine Learning 2024',
      });
      expect(result?.itemType).toBe('conferencePaper');
    });

    it('detects conference paper via known venue name in notes', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Language Models Are Few-Shot Learners',
        notes: ['Accepted at NeurIPS 2020'],
      });
      expect(result?.itemType).toBe('conferencePaper');
    });

    it('detects CVPR / ICCV from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Object Detection via Transformer Networks, CVPR',
      });
      expect(result?.itemType).toBe('conferencePaper');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 3d – Preprint patterns
  // ──────────────────────────────────────────────────────────────
  describe('Tier 3d – Preprint patterns', () => {
    it('detects preprint from "under review" note', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Scaling Laws for Neural Language Models',
        notes: ['Under review at ICML 2025'],
      });
      expect(result?.itemType).toBe('preprint');
    });

    it('detects preprint from "submitted to" note', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Efficient Attention Mechanisms',
        notes: ['Submitted to Journal of Machine Learning Research'],
      });
      expect(result?.itemType).toBe('preprint');
    });

    it('detects preprint from arxiv in filename', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'Generative Models',
        filename: 'arxiv_2310.06825v2.pdf',
      });
      expect(result?.itemType).toBe('preprint');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 3e – Patent
  // ──────────────────────────────────────────────────────────────
  describe('Tier 3e – Patent patterns', () => {
    it('detects patent from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title:
          'Patent Application: Method and System for Training Neural Networks',
      });
      expect(result?.itemType).toBe('patent');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Tier 3f – Dataset
  // ──────────────────────────────────────────────────────────────
  describe('Tier 3f – Dataset patterns', () => {
    it('detects dataset from title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'ImageNet: A Large-Scale Dataset for Visual Recognition',
      });
      expect(result?.itemType).toBe('dataset');
    });

    it('detects annotated corpus in title', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'SQuAD: An Annotated Corpus for Reading Comprehension',
      });
      expect(result?.itemType).toBe('dataset');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────────
  describe('Edge cases', () => {
    it('returns undefined for empty signals', () => {
      expect(inferItemTypeFromPdfSignals({})).toBeUndefined();
    });

    it('returns undefined for a generic journal title with no strong signals', () => {
      const result = inferItemTypeFromPdfSignals({
        title: 'A Novel Approach to Graph Neural Networks',
        journal: 'Nature Communications',
      });
      // No conference, no thesis note, no report keywords → undefined (pipeline defaults to journalArticle)
      expect(result).toBeUndefined();
    });

    it('confidence is always in [0, 1]', () => {
      const cases = [
        { isbn: '9780262035613' },
        { title: 'PhD Thesis on Robotics', notes: ['for the degree of PhD'] },
        { title: 'Technical Report TR-2024', notes: [] },
        { title: 'NeurIPS 2023 Workshop Paper', filename: 'workshop.pdf' },
      ];
      for (const signals of cases) {
        const result = inferItemTypeFromPdfSignals(signals);
        if (result) {
          expect(result.confidence).toBeGreaterThan(0);
          expect(result.confidence).toBeLessThanOrEqual(1);
        }
      }
    });

    it('reason string is always populated when result is returned', () => {
      const result = inferItemTypeFromPdfSignals({ isbn: '9780262035613' });
      expect(result?.reason).toBeTruthy();
    });
  });
});
