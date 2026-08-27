import { AcademicMetadataReducer } from '@/modules/library/legacy/metadata/utils/metadata.util';
import { TranslationSourceType as IngestionSourceType } from '@/modules/library/legacy/translation/dto/translation.dto';

describe('AcademicMetadataReducer', () => {
  describe('cleanFilenameForTitleSearch', () => {
    it('cleans Reference Manager Better BibTeX filenames', () => {
      const filename =
        'Bao2024Deepfmcrispr_deepfm_crispr_prediction_accuracy.pdf';
      const clean =
        AcademicMetadataReducer.cleanFilenameForTitleSearch(filename);
      expect(clean).toBe('deepfm crispr prediction accuracy');
    });

    it('cleans normal hyphen and underscore separated filenames', () => {
      const filename = 'attention-is_all_you_need.pdf';
      const clean =
        AcademicMetadataReducer.cleanFilenameForTitleSearch(filename);
      expect(clean).toBe('attention is all you need');
    });

    it('falls back to base if result is too short', () => {
      const filename = 'ai.pdf';
      const clean =
        AcademicMetadataReducer.cleanFilenameForTitleSearch(filename);
      expect(clean).toBe('ai');
    });
  });

  describe('fromDto & merge', () => {
    it('creates a fresh draft from DTO with defaults', () => {
      const draft = AcademicMetadataReducer.fromDto({
        sourceType: IngestionSourceType.DOI,
        doi: '10.1038/nature12345',
        title: 'Initial Title',
      });

      expect(draft.doi).toBe('10.1038/nature12345');
      expect(draft.title).toBe('Initial Title');
      expect(draft.authors).toEqual([]);
      expect(draft.filename).toBe('document.pdf');
    });

    it('merges incoming metadata without mutating base draft', () => {
      const base = AcademicMetadataReducer.fromDto({
        sourceType: IngestionSourceType.DOI,
        doi: '10.1038/nature12345',
      });

      const incoming = {
        title: 'Deep Learning in Nature',
        authors: ['John Doe', 'Jane Smith'],
        year: 2024,
        journal: 'Nature',
        keywords: ['AI', 'Medicine'],
        tldr: 'Key findings about AI models in medicine.',
        openAccessPdfUrl: 'https://nature.com/article.pdf',
      };

      const merged = AcademicMetadataReducer.merge(base, incoming);

      // Immutability check
      expect(base.title).toBe('');
      expect(base.authors).toEqual([]);

      // Merged values check
      expect(merged.title).toBe('Deep Learning in Nature');
      expect(merged.authors).toEqual(['John Doe', 'Jane Smith']);
      expect(merged.year).toBe(2024);
      expect(merged.journal).toBe('Nature');
      expect(merged.labels).toEqual(['AI', 'Medicine']);
      expect(merged.fileUrl).toBe('https://nature.com/article.pdf');
      expect(merged.notes.length).toBe(1);
      expect(merged.notes[0].content).toContain('Key findings about AI models');
    });

    it('preserves user overrides in base draft', () => {
      const base = AcademicMetadataReducer.fromDto({
        sourceType: IngestionSourceType.DOI,
        title: 'User Custom Title',
        authors: ['Alice Custom'],
      });

      const incoming = {
        title: 'Provider Title',
        authors: ['Bob Provider'],
        year: 2023,
      };

      const merged = AcademicMetadataReducer.merge(base, incoming);
      expect(merged.title).toBe('User Custom Title');
      expect(merged.authors).toEqual(['Alice Custom']);
      expect(merged.year).toBe(2023);
    });

    it('merges BibTeX specific annote and citationKey', () => {
      const base = AcademicMetadataReducer.fromDto({
        sourceType: IngestionSourceType.BIBTEX,
      });

      const bibtexEntry = {
        title: 'BibTeX Article',
        citationKey: 'Vaswani2017',
        annote: 'Special notes from BibTeX file',
      };

      const merged = AcademicMetadataReducer.mergeBibtex(base, bibtexEntry);
      expect(merged.title).toBe('BibTeX Article');
      expect(merged.explicitCitationKey).toBe('Vaswani2017');
      expect(merged.notes.length).toBe(1);
      expect(merged.notes[0].content).toBe('Special notes from BibTeX file');
    });
  });
});
