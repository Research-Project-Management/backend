import { AcademicRegexCatalog } from '@/modules/library/core/domain/academic-regex.catalog';

describe('AcademicRegexCatalog - Page-1 Citation Disambiguation & DOI Scoring', () => {
  describe('scoreDoiCandidate', () => {
    it('awards high score for DOI in header zone with explicit doi prefix', () => {
      const text =
        'IEEE TRANSACTIONS ON PATTERN ANALYSIS AND MACHINE INTELLIGENCE\nDOI: 10.1109/TPAMI.2023.1234567\nPublished by IEEE';
      const matchIndex = text.indexOf('10.1109/TPAMI.2023.1234567');
      const score = AcademicRegexCatalog.scoreDoiCandidate(
        '10.1109/TPAMI.2023.1234567',
        matchIndex,
        text,
      );

      // Base 50 + Prefix 40 + Header 30 + Publisher imprint 35 >= 150
      expect(score).toBeGreaterThanOrEqual(150);
    });

    it('penalizes DOI embedded in numbered citation bracket and et al. context', () => {
      const text =
        'Recent progress has been demonstrated in [1] Vaswani et al., Attention is all you need, doi: 10.48550/arXiv.1706.03762.';
      const matchIndex = text.indexOf('10.48550/arXiv.1706.03762');
      const score = AcademicRegexCatalog.scoreDoiCandidate(
        '10.48550/arXiv.1706.03762',
        matchIndex,
        text,
      );

      // Penalized by bracket (-50) and "et al." (-45)
      expect(score).toBeLessThan(50);
    });

    it('heavily penalizes DOI appearing after References section', () => {
      const text =
        'Main paper content...\n\nReferences\n[1] Doe et al. 2020. doi: 10.1016/j.jbi.2020.103456';
      const matchIndex = text.indexOf('10.1016/j.jbi.2020.103456');
      const score = AcademicRegexCatalog.scoreDoiCandidate(
        '10.1016/j.jbi.2020.103456',
        matchIndex,
        text,
      );

      expect(score).toBeLessThan(0);
    });
  });

  describe('scan with multiple candidate DOIs on Page 1', () => {
    it('selects the publication DOI over a cited reference DOI appearing in an introduction footnote', () => {
      const page1Text = `
        Nature Biotechnology
        Published: 14 October 2023
        DOI: 10.1038/s41587-023-01987-x

        High-Throughput Genome Sequencing in Agriculture
        Alice Walker, Bob Martin

        Abstract
        We report a scalable pipeline for crop genomic analysis...

        1. Introduction
        As pioneered in earlier models [1] (Le et al., doi: 10.1016/j.cell.2018.05.012), 
        deep learning accelerates genomics.
      `;

      const result = AcademicRegexCatalog.scan(page1Text);

      // Must choose the paper's own publication DOI, NOT the cited Cell 2018 paper!
      expect(result.doi).toBe('10.1038/s41587-023-01987-x');
      expect(result.candidateDois).toBeDefined();
      expect(result.candidateDois!.length).toBeGreaterThanOrEqual(2);

      const topCandidate = result.candidateDois![0];
      expect(topCandidate.doi).toBe('10.1038/s41587-023-01987-x');

      const citedCandidate = result.candidateDois!.find(
        (c) => c.doi === '10.1016/j.cell.2018.05.012',
      );
      expect(citedCandidate).toBeDefined();
      expect(topCandidate.score).toBeGreaterThan(citedCandidate!.score);
    });
  });

  describe('arXiv reference pollution vs genuine preprint identification', () => {
    it('rejects an arXiv ID that is cited in an introduction citation bracket or footnote', () => {
      const page1Text = `
        Journal of Machine Learning Research 15 (2014) 1929-1958

        Dropout: A Simple Way to Prevent Neural Networks from Overfitting
        Nitish Srivastava, Geoffrey Hinton, Alex Krizhevsky, Ilya Sutskever, Ruslan Salakhutdinov

        Abstract
        Deep neural networks with a large number of parameters are very powerful machine learning systems.

        1. Introduction
        Regularization techniques have been explored in recent years. In particular, stochastic pooling
        was proposed by Zeiler & Fergus [1] (arXiv:1301.3557) to prevent overfitting in convnets.
      `;

      const result = AcademicRegexCatalog.scan(page1Text);

      // Must detect JMLR journal metadata correctly!
      expect(result.journal).toBe('Journal of Machine Learning Research');
      expect(result.year).toBe(2014);
      expect(result.volume).toBe('15');
      expect(result.pages).toBe('1929-1958');

      // Must NOT attribute the paper to the cited arXiv ID or fabricate an arXiv DOI!
      expect(result.arxivId).toBeUndefined();
      expect(result.doi).toBeUndefined();
    });

    it('correctly keeps genuine arXiv preprint ID when located in the document header', () => {
      const preprintText = `
        arXiv:2303.08774v2 [cs.CV] 15 Mar 2023
        Scaling Vision Transformers to 22 Billion Parameters
        Mostafa Dehghani, Josip Djolonga, Alexey Dosovitskiy
      `;

      const result = AcademicRegexCatalog.scan(preprintText);
      expect(result.arxivId).toBe('2303.08774v2');
      expect(result.primaryCategory).toBe('cs.CV');
      expect(result.doi).toBe('10.48550/arXiv.2303.08774v2');
    });
  });
});
