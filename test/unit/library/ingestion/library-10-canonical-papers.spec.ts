/**
 * Regression test: 10 canonical academic papers across diverse itemTypes.
 *
 * Tests the full normalization pipeline (NormalizationPolicy) and the new
 * itemType heuristic (inferItemTypeFromPdfSignals) end-to-end with real
 * bibliographic data, verifying:
 *   1. itemType is correctly assigned from CrossRef-style structured data
 *   2. Key fields (title, authors, year, DOI, venue) are correctly normalized
 *   3. inferItemTypeFromPdfSignals correctly classifies PDFs without IDs
 *
 * Papers selected to cover all common document types:
 *   ① journalArticle  — Attention Is All You Need (NeurIPS 2017)
 *   ② journalArticle  — Nature: AlphaFold protein structure (2021)
 *   ③ conferencePaper — BERT (NAACL 2019)
 *   ④ conferencePaper — ResNet CVPR 2016
 *   ⑤ preprint        — GPT-4 Technical Report (arXiv 2023)
 *   ⑥ preprint        — BioRxiv COVID-19 preprint
 *   ⑦ thesis          — PhD thesis example (no DOI)
 *   ⑧ report          — NIST Cybersecurity Framework
 *   ⑨ book            — Deep Learning textbook (Goodfellow 2016)
 *   ⑩ dataset         — ImageNet (ILSVRC) dataset paper
 */
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { inferItemTypeFromPdfSignals } from '@/modules/library/shared-kernel/utils/bibliographic.utils';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makePolicy() {
  return new NormalizationPolicy();
}

/** Build a raw metadata object similar to what identify.stage.ts produces */
function rawMeta(overrides: Record<string, any>) {
  return {
    title: '',
    itemType: '',
    creators: [],
    authors: [],
    tags: [],
    notes: [],
    extraFields: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('10 Canonical Papers — Full Metadata Accuracy Regression', () => {
  let policy: NormalizationPolicy;

  beforeAll(() => {
    policy = makePolicy();
  });

  // ① ─────────────────────────────────────────────────────────────────────────
  describe('① journalArticle — Attention Is All You Need (Vaswani et al., 2017)', () => {
    const raw = rawMeta({
      title: 'Attention Is All You Need',
      itemType: 'journal-article',
      doi: '10.5555/3295222.3295349',
      year: 2017,
      authors: [
        'Vaswani, Ashish',
        'Shazeer, Noam',
        'Parmar, Niki',
        'Uszkoreit, Jakob',
      ],
      journal: 'Advances in Neural Information Processing Systems',
      volume: '30',
      pages: '5998-6008',
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...',
    });

    it('normalizes itemType to journalArticle', () => {
      const result = policy.normalize(raw);
      expect(result.itemType).toBe('journalArticle');
    });

    it('preserves title verbatim', () => {
      const result = policy.normalize(raw);
      expect(result.title).toBe('Attention Is All You Need');
    });

    it('normalizes DOI correctly', () => {
      const result = policy.normalize(raw);
      expect(result.doi).toBe('10.5555/3295222.3295349');
    });

    it('extracts year as number', () => {
      const result = policy.normalize(raw);
      expect(result.year).toBe(2017);
    });

    it('parses at least 4 authors', () => {
      const result = policy.normalize(raw);
      const count = result.creators?.length ?? result.authors?.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(4);
    });

    it('preserves journal name', () => {
      const result = policy.normalize(raw);
      expect(result.journal ?? result.publicationTitle).toContain(
        'Neural Information Processing',
      );
    });
  });

  // ② ─────────────────────────────────────────────────────────────────────────
  describe('② journalArticle — AlphaFold protein structure prediction (Nature 2021)', () => {
    const raw = rawMeta({
      title: 'Highly accurate protein structure prediction with AlphaFold',
      itemType: 'journal-article',
      doi: '10.1038/s41586-021-03819-2',
      year: 2021,
      authors: ['Jumper, John', 'Evans, Richard', 'Pritzel, Alexander'],
      journal: 'Nature',
      volume: '596',
      issue: '7873',
      pages: '583-589',
      issn: '0028-0836',
      abstract: 'Protein structure prediction using deep learning...',
      publisher: 'Springer Nature',
    });

    it('normalizes itemType to journalArticle', () => {
      expect(policy.normalize(raw).itemType).toBe('journalArticle');
    });

    it('correctly normalizes DOI from Nature', () => {
      const result = policy.normalize(raw);
      expect(result.doi).toBe('10.1038/s41586-021-03819-2');
    });

    it('keeps volume and issue', () => {
      const result = policy.normalize(raw);
      expect(result.volume).toBe('596');
      expect(result.issue).toBe('7873');
    });

    it('keeps pages', () => {
      expect(policy.normalize(raw).pages).toBe('583-589');
    });

    it('has non-empty abstract', () => {
      const result = policy.normalize(raw);
      expect(result.abstract?.length).toBeGreaterThan(10);
    });
  });

  // ③ ─────────────────────────────────────────────────────────────────────────
  describe('③ conferencePaper — BERT (Devlin et al., NAACL 2019)', () => {
    const raw = rawMeta({
      title:
        'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      itemType: 'proceedings-article',
      doi: '10.18653/v1/N19-1423',
      year: 2019,
      authors: [
        'Devlin, Jacob',
        'Chang, Ming-Wei',
        'Lee, Kenton',
        'Toutanova, Kristina',
      ],
      conferenceName:
        'Annual Conference of the North American Chapter of the Association for Computational Linguistics',
      proceedingsTitle: 'Proceedings of NAACL-HLT 2019',
      pages: '4171-4186',
      abstract:
        'We introduce a new language representation model called BERT...',
    });

    it('maps proceedings-article to conferencePaper', () => {
      expect(policy.normalize(raw).itemType).toBe('conferencePaper');
    });

    it('preserves full title', () => {
      const result = policy.normalize(raw);
      expect(result.title).toContain('BERT');
      expect(result.title).toContain('Bidirectional Transformers');
    });

    it('has all 4 authors', () => {
      const result = policy.normalize(raw);
      const count = result.creators?.length ?? result.authors?.length ?? 0;
      expect(count).toBe(4);
    });

    it('preserves DOI (DOIs are case-insensitive; normalized to lowercase)', () => {
      // normalizeDoi() lowercases the suffix per DOI spec — case-insensitive by definition.
      expect(policy.normalize(raw).doi).toBe('10.18653/v1/n19-1423');
    });
  });

  // ④ ─────────────────────────────────────────────────────────────────────────
  describe('④ conferencePaper — Deep Residual Learning (He et al., CVPR 2016)', () => {
    const raw = rawMeta({
      title: 'Deep Residual Learning for Image Recognition',
      itemType: 'conference-paper',
      doi: '10.1109/CVPR.2016.90',
      year: 2016,
      authors: ['He, Kaiming', 'Zhang, Xiangyu', 'Ren, Shaoqing', 'Sun, Jian'],
      conferenceName: 'CVPR 2016',
      proceedingsTitle:
        'Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition',
      pages: '770-778',
    });

    it('maps conference-paper to conferencePaper', () => {
      expect(policy.normalize(raw).itemType).toBe('conferencePaper');
    });

    it('preserves year 2016', () => {
      expect(policy.normalize(raw).year).toBe(2016);
    });

    it('heuristic correctly identifies conferencePaper from CVPR in proceedings title (no DOI path)', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'Deep Residual Learning for Image Recognition',
        notes: [{ content: 'Presented at CVPR 2016' }],
      });
      expect(inferred?.itemType).toBe('conferencePaper');
    });
  });

  // ⑤ ─────────────────────────────────────────────────────────────────────────
  describe('⑤ preprint — GPT-4 Technical Report (OpenAI, arXiv 2303.08774)', () => {
    const raw = rawMeta({
      title: 'GPT-4 Technical Report',
      itemType: 'preprint',
      arxivId: '2303.08774',
      year: 2023,
      authors: ['OpenAI'],
      abstract:
        'We report the development of GPT-4, a large-scale, multimodal model...',
      notes: [{ content: 'Preprint. arXiv:2303.08774' }],
    });

    it('keeps itemType as preprint', () => {
      expect(policy.normalize(raw).itemType).toBe('preprint');
    });

    it('normalizes arXiv ID', () => {
      const result = policy.normalize(raw);
      expect(result.arxivId).toBe('2303.08774');
    });

    it('heuristic detects preprint from "Preprint." note (title without "Technical Report")', () => {
      // In production, arxivId triggers hasAuthoritativeId=true so heuristics
      // are skipped entirely. This tests the heuristic in isolation with a
      // clean title that does not contain "Technical Report" (which would
      // trigger the REPORT_TITLE pattern first).
      const inferred = inferItemTypeFromPdfSignals({
        title: 'GPT-4: Multimodal Language Model by OpenAI',
        notes: [{ content: 'Preprint. arXiv:2303.08774' }],
      });
      expect(inferred?.itemType).toBe('preprint');
    });

    it('heuristic detects preprint from arxiv_ filename (title without "Technical Report")', () => {
      // NOTE: title "GPT-4 Technical Report" triggers REPORT_TITLE before
      // PREPRINT_FILENAME — this is correct priority (title-level signal beats
      // filename). In production, arxivId bypasses heuristics entirely.
      const inferred = inferItemTypeFromPdfSignals({
        title: 'GPT-4: Multimodal Language Model',
        filename: 'arxiv_2303.08774.pdf',
      });
      expect(inferred?.itemType).toBe('preprint');
    });
  });

  // ⑥ ─────────────────────────────────────────────────────────────────────────
  describe('⑥ preprint — BioRxiv COVID-19 preprint (under review)', () => {
    const raw = rawMeta({
      title:
        'Structure of SARS-CoV-2 spike receptor-binding domain bound to ACE2',
      itemType: 'preprint',
      doi: '10.1101/2020.02.20.956235',
      year: 2020,
      authors: ['Lan, Jun', 'Ge, Jiwan'],
      abstract:
        'A pneumonia outbreak associated with a novel coronavirus (SARS-CoV-2)...',
      notes: [
        {
          content:
            'bioRxiv preprint doi: 10.1101/2020.02.20.956235; Under review at Nature',
        },
      ],
    });

    it('keeps itemType as preprint', () => {
      expect(policy.normalize(raw).itemType).toBe('preprint');
    });

    it('heuristic detects preprint from "Under review" in notes', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title:
          'Structure of SARS-CoV-2 spike receptor-binding domain bound to ACE2',
        notes: [{ content: 'Under review at Nature' }],
      });
      expect(inferred?.itemType).toBe('preprint');
    });

    it('heuristic detects preprint from biorxiv in notes', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'SARS-CoV-2 spike protein study',
        notes: ['bioRxiv preprint 2020'],
      });
      expect(inferred?.itemType).toBe('preprint');
    });
  });

  // ⑦ ─────────────────────────────────────────────────────────────────────────
  describe('⑦ thesis — PhD Thesis (no DOI, plain PDF upload)', () => {
    it('heuristic detects PhD thesis from title', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'Scalable Distributed Machine Learning: A PhD Thesis',
        filename: 'alice_smith_phd_thesis_mit_2022.pdf',
      });
      expect(inferred?.itemType).toBe('thesis');
      expect(inferred?.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('heuristic detects thesis from "for the degree of" note', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'Neural Networks for Natural Language Processing',
        notes: [
          'A dissertation submitted for the degree of Doctor of Philosophy, University of Cambridge, 2021',
        ],
      });
      expect(inferred?.itemType).toBe('thesis');
      expect(inferred?.confidence).toBeGreaterThan(0.85);
    });

    it('heuristic detects thesis from filename alone when title is generic', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'Uploaded Document',
        filename: 'phd_dissertation_2023.pdf',
      });
      expect(inferred?.itemType).toBe('thesis');
    });

    it('NormalizationPolicy preserves thesis itemType when set', () => {
      const raw = rawMeta({
        title: 'Scalable Distributed Systems',
        itemType: 'thesis',
        year: 2022,
        authors: ['Smith, Alice'],
        publisher: 'MIT',
      });
      expect(policy.normalize(raw).itemType).toBe('thesis');
    });
  });

  // ⑧ ─────────────────────────────────────────────────────────────────────────
  describe('⑧ report — NIST Cybersecurity Framework (no DOI)', () => {
    it('heuristic detects report from "NIST" in notes', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'Framework for Improving Critical Infrastructure Cybersecurity',
        notes: ['NIST Special Publication, Version 1.1, April 2018'],
      });
      expect(inferred?.itemType).toBe('report');
    });

    it('heuristic detects report from "Technical Report" in title', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title:
          'A Technical Report on Adversarial Robustness in Neural Networks',
        filename: 'adversarial_robustness_techreport.pdf',
      });
      expect(inferred?.itemType).toBe('report');
    });

    it('NormalizationPolicy preserves report itemType when set', () => {
      const raw = rawMeta({
        title: 'Framework for Improving Critical Infrastructure Cybersecurity',
        itemType: 'report',
        year: 2018,
        authors: ['National Institute of Standards and Technology'],
        publisher: 'NIST',
      });
      expect(policy.normalize(raw).itemType).toBe('report');
    });
  });

  // ⑨ ─────────────────────────────────────────────────────────────────────────
  describe('⑨ book — Deep Learning (Goodfellow et al., MIT Press 2016)', () => {
    const raw = rawMeta({
      title: 'Deep Learning',
      itemType: 'book',
      isbn: '9780262035613',
      year: 2016,
      authors: ['Goodfellow, Ian', 'Bengio, Yoshua', 'Courville, Aaron'],
      publisher: 'MIT Press',
      place: 'Cambridge, MA',
      abstract:
        'Deep learning is a form of machine learning that enables computers to learn from experience...',
    });

    it('keeps itemType as book', () => {
      expect(policy.normalize(raw).itemType).toBe('book');
    });

    it('preserves ISBN', () => {
      const result = policy.normalize(raw);
      expect(result.isbn).toContain('9780262035613');
    });

    it('preserves publisher', () => {
      expect(policy.normalize(raw).publisher).toBe('MIT Press');
    });

    it('heuristic identifies book from ISBN when no structured type provided', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'Deep Learning',
        isbn: '9780262035613',
      });
      expect(inferred?.itemType).toBe('book');
      expect(inferred?.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  // ⑩ ─────────────────────────────────────────────────────────────────────────
  describe('⑩ dataset — ImageNet Large Scale Visual Recognition Challenge', () => {
    const raw = rawMeta({
      title: 'ImageNet Large Scale Visual Recognition Challenge',
      itemType: 'dataset',
      doi: '10.1007/s11263-015-0816-y',
      year: 2015,
      authors: ['Russakovsky, Olga', 'Deng, Jia', 'Su, Hao'],
      journal: 'International Journal of Computer Vision',
      volume: '115',
      issue: '3',
      pages: '211-252',
      abstract:
        'The ImageNet Large Scale Visual Recognition Challenge (ILSVRC)...',
    });

    it('keeps itemType as dataset', () => {
      expect(policy.normalize(raw).itemType).toBe('dataset');
    });

    it('preserves DOI', () => {
      expect(policy.normalize(raw).doi).toBe('10.1007/s11263-015-0816-y');
    });

    it('heuristic detects dataset from title keyword', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'ImageNet: A Large-Scale Dataset for Visual Recognition',
        filename: 'imagenet_dataset_paper.pdf',
      });
      expect(inferred?.itemType).toBe('dataset');
    });

    it('heuristic detects annotated corpus from title', () => {
      const inferred = inferItemTypeFromPdfSignals({
        title: 'CoNLL-2003: An Annotated Corpus for Named Entity Recognition',
      });
      expect(inferred?.itemType).toBe('dataset');
    });
  });

  // ─── Cross-cutting: heuristic must NOT fire on plain journal papers ─────────
  describe('Negative cases — generic journal papers must return undefined', () => {
    it('plain journal title with no special signals → undefined (pipeline defaults to journalArticle)', () => {
      expect(
        inferItemTypeFromPdfSignals({
          title:
            'A Novel Approach to Graph Neural Networks for Molecular Property Prediction',
          journal: 'Journal of Chemical Information and Modeling',
        }),
      ).toBeUndefined();
    });

    it('empty signals → undefined', () => {
      expect(inferItemTypeFromPdfSignals({})).toBeUndefined();
    });

    it('title with only common words → undefined', () => {
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Introduction to Machine Learning',
          filename: 'lecture_notes.pdf',
        }),
      ).toBeUndefined();
    });
  });
});
