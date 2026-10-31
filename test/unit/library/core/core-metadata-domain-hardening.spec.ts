import {
  stripSurroundingPunctuation,
  normalizeDoi,
  deriveDirectPdfUrl,
  isValidIssnChecksum,
  generateCitationKey,
} from '@/modules/library/core/domain/identifier.domain';
import { AcademicRegexCatalog } from '@/modules/library/core/domain/academic-regex.catalog';
import { AcademicSearchQueryEngine } from '@/modules/library/core/domain/academic-search-query.domain';
import {
  cleanAuthorName,
  splitAuthorString,
  parseCreatorString,
  isVietnameseName,
  isVancouverName,
  splitConcatenatedAuthors,
} from '@/modules/library/core/domain/author.domain';
import { mergeCanonicalCreators } from '@/modules/library/core/domain/creator-normalizer.domain';
import {
  stripXmlAndHtmlTags,
  stripLatexBraces,
  cleanAbstractText,
} from '@/modules/library/core/domain/academic-text.domain';
import { sanitizeItemTitle } from '@/modules/library/core/domain/academic-title.domain';
import {
  ItemProvenancePolicy,
  COUPLED_METADATA_ALIASES,
} from '@/modules/library/core/domain/item-provenance.domain';
import { resolveProviderFieldWeight, buildAnnotationSortIndex } from '@/modules/library/core';
import { REVERSE_FIELD_ALIASES } from '@/modules/library/core/types/schema.constants';

describe('Core Metadata Domain Hardening (Loop 2 Regression Suite)', () => {
  describe('1. identifier.domain.ts', () => {
    it('eliminates ReDoS in normalizeDoi on adversarial repeated /doi/ URL paths in <5ms', () => {
      // Warm up JIT regex compilation
      normalizeDoi('https://publisher.example.com/doi/10.1000/warmup');

      const adversarialUrl =
        'https://publisher.example.com' +
        '/doi/10.1000/a'.repeat(40) +
        '!';
      const start = performance.now();
      const result = normalizeDoi(adversarialUrl);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5);
      expect(result).toBeDefined();
    });

    it('preserves balanced parentheses in SICI/Lancet DOIs while stripping unbalanced outer parentheses', () => {
      expect(
        stripSurroundingPunctuation('10.1002/(SICI)1097-0258(19980815)'),
      ).toBe('10.1002/(SICI)1097-0258(19980815)');
      expect(normalizeDoi('10.1002/(SICI)1097-0258(19980815)')).toBe(
        '10.1002/(sici)1097-0258(19980815)',
      );

      expect(
        stripSurroundingPunctuation('10.1016/S0140-6736(97)11096-0)'),
      ).toBe('10.1016/S0140-6736(97)11096-0');
      expect(normalizeDoi('(doi:10.1016/S0140-6736(97)11096-0).)')).toBe(
        '10.1016/s0140-6736(97)11096-0',
      );
    });

    it('supports old-style arXiv IDs in deriveDirectPdfUrl and never returns undefined.pdf', () => {
      expect(
        deriveDirectPdfUrl('https://arxiv.org/abs/hep-th/9901001v2'),
      ).toBe('https://arxiv.org/pdf/hep-th/9901001v2.pdf');
      expect(deriveDirectPdfUrl('https://arxiv.org/abs/1706.03762v5')).toBe(
        'https://arxiv.org/pdf/1706.03762v5.pdf',
      );
      expect(deriveDirectPdfUrl('https://arxiv.org/abs/123.456')).toBeUndefined();
    });

    it('validates ISO 3297 modulo-11 ISSN checksums including X check digits', () => {
      expect(isValidIssnChecksum('0378-5955')).toBe(true);
      expect(isValidIssnChecksum('0018-9219')).toBe(true);
      expect(isValidIssnChecksum('2434-561X')).toBe(true);
      expect(isValidIssnChecksum('0378-5954')).toBe(false);
      expect(isValidIssnChecksum('invalid')).toBe(false);
    });

    it('generates accurate citation keys for single-field institutions and Vietnamese names', () => {
      expect(
        generateCitationKey({
          creators: [
            {
              lastName: 'World Health Organization',
              fieldMode: 1,
            },
          ],
          year: 2024,
          title: 'Global Malaria Report',
        }),
      ).toBe('world2024global');

      expect(
        generateCitationKey({
          creators: [{ fullName: 'Nguyễn Văn An' }],
          year: 2025,
          title: 'Deep Learning for Vietnamese NLP',
        }),
      ).toBe('nguyen2025deep');

      expect(
        generateCitationKey({
          authors: ['Nguyễn Văn An'],
          year: 2025,
          title: 'Deep Learning for Vietnamese NLP',
        }),
      ).toBe('nguyen2025deep');
    });
  });

  describe('2. academic-regex.catalog.ts', () => {
    it('preserves balanced parentheses in AcademicRegexCatalog.cleanDoi', () => {
      expect(
        AcademicRegexCatalog.cleanDoi('10.1002/(SICI)1097-0258(19980815)'),
      ).toBe('10.1002/(SICI)1097-0258(19980815)');
      expect(
        AcademicRegexCatalog.cleanDoi('10.1016/S0140-6736(97)11096-0)).'),
      ).toBe('10.1016/S0140-6736(97)11096-0');
    });

    it('ignores TOC References lines with leader dots/page numbers and penalizes derivative/inline citations', () => {
      const textWithToc = [
        'Table of Contents',
        '  1. Introduction ........ 1',
        '  References ........ 42',
        '',
        'DOI: 10.1145/3581783.3612345',
        'Title of the Paper',
      ].join('\n');
      const idx = textWithToc.indexOf('10.1145/3581783.3612345');
      const score = AcademicRegexCatalog.scoreDoiCandidate(
        '10.1145/3581783.3612345',
        idx,
        textWithToc,
      );
      expect(score).toBeGreaterThanOrEqual(110);

      const derivativeText =
        'Figure 2: Architecture adapted from doi: 10.1038/s41586-021-03819-2.';
      const derivIdx = derivativeText.indexOf('10.1038/s41586-021-03819-2');
      const derivScore = AcademicRegexCatalog.scoreDoiCandidate(
        '10.1038/s41586-021-03819-2',
        derivIdx,
        derivativeText,
      );
      expect(derivScore).toBeLessThan(60);

      const inlinePublisherCite =
        'As shown in [1] Smith et al., Nature, vol. 500, 10.1038/nature12345.';
      const inlineIdx = inlinePublisherCite.indexOf('10.1038/nature12345');
      const inlineScore = AcademicRegexCatalog.scoreDoiCandidate(
        '10.1038/nature12345',
        inlineIdx,
        inlinePublisherCite,
      );
      expect(inlineScore).toBeLessThan(0);
    });

    it('validates ISBN/ISSN checksums in scan, prevents newline swallowing in ISBN, and rejects bare year ranges as ISSN', () => {
      const multilineFakeIsbn = 'ISBN: 0-306-406\n2023 Conference Proceedings';
      expect(AcademicRegexCatalog.scan(multilineFakeIsbn).isbn).toBeUndefined();

      const invalidChecksumIsbn = 'ISBN: 978-0-306-40615-8';
      expect(
        AcademicRegexCatalog.scan(invalidChecksumIsbn).isbn,
      ).toBeUndefined();

      const validIsbn = 'ISBN: 978-0-306-40615-7';
      expect(AcademicRegexCatalog.scan(validIsbn).isbn).toBe('9780306406157');

      // 2020-2024 happens to satisfy mod-11 (44 % 11 === 0) but is a year range
      const yearRangeText = 'Study period 2020-2024 across hospitals.';
      expect(AcademicRegexCatalog.scan(yearRangeText).issn).toBeUndefined();

      const validIssnText = 'ISSN 0378-5955';
      expect(AcademicRegexCatalog.scan(validIssnText).issn).toBe('0378-5955');
    });
  });

  describe('3. academic-search-query.domain.ts', () => {
    it('blocks optional-quantifier and overlapping character-class ReDoS patterns in isSafeRegex', () => {
      expect(AcademicSearchQueryEngine.isSafeRegex('(a?a?)+$')).toBe(false);
      expect(AcademicSearchQueryEngine.isSafeRegex('(a?)+$')).toBe(false);
      expect(AcademicSearchQueryEngine.isSafeRegex('([a-z]|\\w|a)+$')).toBe(
        false,
      );
      expect(AcademicSearchQueryEngine.isSafeRegex('(\\d|0)+$')).toBe(false);
      expect(
        AcademicSearchQueryEngine.isSafeRegex('fig(?:ure)?\\s+\\d+'),
      ).toBe(true);
    });
  });

  describe('4. author.domain.ts & creator-normalizer.domain.ts', () => {
    it('strips trailing et al. and and others before comma splitting and in cleanAuthorName', () => {
      expect(cleanAuthorName('John Smith et al.')).toBe('John Smith');
      expect(cleanAuthorName('Smith, J., et al.')).toBe('Smith, J.');
      expect(splitAuthorString('Smith, J., et al.')).toEqual(['Smith, J.']);
      expect(splitAuthorString('John Smith and others')).toEqual([
        'John Smith',
      ]);
    });

    it('strips LaTeX text styling commands in cleanAuthorName', () => {
      expect(cleanAuthorName('{\\bf John Smith}')).toBe('John Smith');
      expect(cleanAuthorName('\\textbf{Jane Doe}')).toBe('Jane Doe');
      expect(cleanAuthorName('{\\it Albert Einstein}')).toBe(
        'Albert Einstein',
      );
    });

    it('splits Vietnamese compound surnames accurately in parseCreatorString', () => {
      const parsed = parseCreatorString('Nguyễn Phúc Vĩnh Tường');
      expect(parsed.lastName).toBe('Nguyễn Phúc');
      expect(parsed.firstName).toBe('Vĩnh Tường');
      expect(parsed.fullName).toBe('Nguyễn Phúc Vĩnh Tường');
    });

    it('avoids false positives on unaccented 2-token Western/Turkish/Chinese names in isVietnameseName', () => {
      expect(isVietnameseName('Ma Smith')).toBe(false);
      expect(isVietnameseName('Can Yaman')).toBe(false);
      expect(isVietnameseName('Ho Lee')).toBe(false);
      expect(isVietnameseName('Vi Kim')).toBe(false);
      expect(isVietnameseName('An Lee')).toBe(false);
      expect(isVietnameseName('Nguyen Smith')).toBe(false);
      expect(isVietnameseName('Nguyen An')).toBe(true);
      expect(isVietnameseName('Tran Binh')).toBe(true);
    });

    it('attaches surname particles when combined with generational suffixes and lowercases particle checks', () => {
      const parsed = parseCreatorString('Robert van der Graaff Jr.');
      expect(parsed.firstName).toBe('Robert');
      expect(parsed.lastName).toBe('van der Graaff Jr.');
      expect(parsed.fullName).toBe('Robert van der Graaff Jr.');

      expect(isVancouverName('Van Der Berg AB')).toBe(true);
      expect(
        splitConcatenatedAuthors(
          'Johannes Van Der Waals Hendrik Lorentz Pieter Zeeman',
          6,
        ),
      ).toEqual([
        'Johannes Van Der Waals',
        'Hendrik Lorentz',
        'Pieter Zeeman',
      ]);
    });

    it('cleans emails and prefixes in mergeCanonicalCreators before checking isNoiseAuthorName', () => {
      const merged = mergeCanonicalCreators({
        creators: [
          { name: 'John Smith <john@mit.edu>' },
          { fullName: 'Author: Jane Doe' },
        ],
      });
      expect(merged).toHaveLength(2);
      expect(merged?.[0]).toEqual(
        expect.objectContaining({
          firstName: 'John',
          lastName: 'Smith',
          fullName: 'John Smith',
        }),
      );
      expect(merged?.[1]).toEqual(
        expect.objectContaining({
          firstName: 'Jane',
          lastName: 'Doe',
          fullName: 'Jane Doe',
        }),
      );
    });
  });

  describe('5. academic-text.domain.ts & academic-title.domain.ts', () => {
    it('protects angle brackets inside inline LaTeX math from HTML tag stripping', () => {
      expect(
        stripXmlAndHtmlTags(
          'Quantum expectation $<psi | H | psi>$ and bound $<a + b>$ in <i>H</i><sub>2</sub>O',
        ),
      ).toBe('Quantum expectation $<psi | H | psi>$ and bound $<a + b>$ in H₂O');

      expect(
        sanitizeItemTitle('Matrix Elements $<psi | H | psi>$ in Quantum Dots'),
      ).toBe('Matrix Elements $<psi | H | psi>$ in Quantum Dots');
    });

    it('strips LaTeX text-formatting commands outside math in stripLatexBraces', () => {
      expect(
        stripLatexBraces(
          '\\textbf{Deep Learning} with {\\emph{Attention}} and $\\mathbf{X}$',
        ),
      ).toBe('Deep Learning with Attention and $\\mathbf{X}$');
    });

    it('does not truncate abstracts mentioning bare "Copyright 1998" in legal/historical prose', () => {
      const legalAbstract =
        'This article examines the Sonny Bono Copyright Term Extension Act and Copyright 1998 reforms in the United States, demonstrating how extended terms affect public domain digitization.';
      expect(cleanAbstractText(legalAbstract)).toBe(legalAbstract);
    });
  });

  describe('6. item-provenance.domain.ts, source-weights.catalog.ts, sort-index.domain.ts, schema.constants.ts', () => {
    it('protects existing fields with item-level high authority in filterAiMetadataPatch and returns updatedFieldProvenance', () => {
      const currentMeta = {
        title: 'Authoritative CrossRef Title',
        source: 'CrossRef',
      };
      const { filteredPatch, updatedFieldProvenance } =
        ItemProvenancePolicy.filterAiMetadataPatch(currentMeta, {
          title: 'AI Hallucinated Title',
          abstract: 'AI Extracted Abstract',
          aiSummary: 'Short summary',
        });

      expect(filteredPatch.title).toBeUndefined();
      expect(filteredPatch.abstract).toBe('AI Extracted Abstract');
      expect(filteredPatch.aiSummary).toBe('Short summary');
      expect(updatedFieldProvenance?.abstract).toEqual(
        expect.objectContaining({
          source: 'AIMetadata',
          confidence: 0.7,
        }),
      );
    });

    it('enforces symmetric COUPLED_METADATA_ALIASES and locks new tracked manual keys', () => {
      for (const [key, aliases] of Object.entries(COUPLED_METADATA_ALIASES)) {
        for (const alias of aliases) {
          expect(COUPLED_METADATA_ALIASES[alias]).toBeDefined();
          expect(COUPLED_METADATA_ALIASES[alias]).toContain(key);
        }
      }

      const updatedMetadata: Record<string, unknown> = {};
      ItemProvenancePolicy.applyManualEditLocks({
        existingMeta: {},
        dataRecord: { numPages: '350', citeKey: 'knuth1997art', issue: '4' },
        updatedMetadata,
      });
      expect(updatedMetadata.lockedFields).toEqual(
        expect.arrayContaining([
          'numPages',
          'numberOfPages',
          'citeKey',
          'citationKey',
          'issue',
          'number',
        ]),
      );
    });

    it('returns 0.45 fallback weight for unknown providers, maps REVERSE_FIELD_ALIASES.citationKey to citeKey, and clamps sort index coordinates', () => {
      expect(resolveProviderFieldWeight('SomeUnrecognizedScraper')).toBe(0.45);
      expect(REVERSE_FIELD_ALIASES.citationKey).toBe('citeKey');
      expect(buildAnnotationSortIndex(12, 15.5, 200)).toBe('0012|99999|99999');
    });
  });
});
