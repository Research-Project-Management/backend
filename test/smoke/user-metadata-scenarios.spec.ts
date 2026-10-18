import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import {
  cleanAuthorName,
  splitAuthorString,
  cleanAbstractText,
  sanitizeItemTitle,
  normalizeDoi,
  normalizeArxivId,
  normalizeIsbn,
  normalizePmid,
} from '@/modules/library/core';
import { AcademicRegexCatalog } from '@/modules/library/core/domain/academic-regex.catalog';
import { MetadataReconciliationService } from '@/modules/library/ingestion/services/metadata-reconciliation.service';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata.types';
import { buildMockLibraryItem } from '@test/factories';

describe('🧪 Researcher Persona: Comprehensive Metadata Testing Suite', () => {
  let typesService: TypesService;
  let schemaValidator: ZoteroSchemaValidatorService;
  let itemTransformer: ItemTransformer;
  let cslEngine: CslEngineService;
  let reconciliationService: MetadataReconciliationService;

  beforeAll(() => {
    typesService = new TypesService();
    schemaValidator = new ZoteroSchemaValidatorService(typesService);
    itemTransformer = new ItemTransformer(typesService);
    cslEngine = new CslEngineService();
    cslEngine.initTemplates();
    reconciliationService = new MetadataReconciliationService();
  });

  // =========================================================================
  // SCENARIO 1: Academic Item Types & Schemas
  // =========================================================================
  describe('Scenario 1: Testing Diverse Academic Item Types & Field Validation', () => {
    it('Case 1.1: Journal Article - Validates standard academic paper schema', () => {
      const journalItem = {
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        volume: '30',
        issue: '1',
        pages: '5998-6008',
        date: '2017',
        doi: '10.5555/3295222.3295349',
        issn: '1049-5258',
      };

      const result = schemaValidator.validateAndSanitizeItem(
        'journalArticle',
        journalItem,
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.publicationTitle).toBe(
        journalItem.publicationTitle,
      );
      expect(result.sanitizedItem.volume).toBe('30');
      expect(result.sanitizedItem.doi).toBe(journalItem.doi);
    });

    it('Case 1.2: Book & Book Section - Validates ISBN, publisher, edition', () => {
      const bookItem = {
        title: 'Deep Learning',
        itemType: 'book',
        publisher: 'MIT Press',
        place: 'Cambridge, MA',
        date: '2016',
        isbn: '978-0-262-03384-8',
        edition: '1st',
        numberOfPages: '800',
      };

      const result = schemaValidator.validateAndSanitizeItem('book', bookItem);
      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.publisher).toBe('MIT Press');
      expect(result.sanitizedItem.isbn).toBe('978-0-262-03384-8');

      // Book section (chapter)
      const chapterItem = {
        title: 'Convolutional Neural Networks',
        itemType: 'bookSection',
        bookTitle: 'Deep Learning',
        publisher: 'MIT Press',
        pages: '330-372',
      };
      const chapterResult = schemaValidator.validateAndSanitizeItem(
        'bookSection',
        chapterItem,
      );
      expect(chapterResult.valid).toBe(true);
      expect(chapterResult.sanitizedItem.bookTitle).toBe('Deep Learning');
      expect(chapterResult.sanitizedItem.pages).toBe('330-372');
    });

    it('Case 1.3: Preprint - Validates repository & archiveID (arXiv)', () => {
      const preprintItem = {
        title: 'Generative Adversarial Nets',
        itemType: 'preprint',
        repository: 'arXiv',
        archiveID: 'arXiv:1406.2661',
        date: '2014-06-10',
      };

      const result = schemaValidator.validateAndSanitizeItem(
        'preprint',
        preprintItem,
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.repository).toBe('arXiv');
      expect(result.sanitizedItem.archiveID).toBe('arXiv:1406.2661');
    });

    it('Case 1.4: Webpage & Blog Post - Validates URL and access date', () => {
      const webItem = {
        title: 'An Overview of Multi-Agent AI Systems',
        itemType: 'webpage',
        websiteTitle: 'DeepMind Research Blog',
        url: 'https://deepmind.google/discover/blog/multi-agent-systems/',
        accessDate: '2026-10-13T10:00:00Z',
      };

      const result = schemaValidator.validateAndSanitizeItem(
        'webpage',
        webItem,
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.url).toBe(webItem.url);
      expect(result.sanitizedItem.accessDate).toBe(webItem.accessDate);
    });
  });

  // =========================================================================
  // SCENARIO 2: Global Author Names & OCR/Scraped Noise Handling
  // =========================================================================
  describe('Scenario 2: International Author Names, Cultural Formats & Noise Immunity', () => {
    it('Case 2.1: Western names with particles, generational suffixes and initials', () => {
      const name1 = cleanAuthorName('Ludwig van Beethoven');
      expect(name1).toBe('Ludwig van Beethoven');

      const name2 = cleanAuthorName('Donald Knuth III');
      expect(name2).toBe('Donald Knuth III');

      const name3 = cleanAuthorName('Martin Luther King Jr.');
      expect(name3).toBe('Martin Luther King Jr.');

      // CSL parsing
      const csl1 = CslJsonMapper.parseStringName('Ludwig van Beethoven');
      expect(csl1.family).toBe('van Beethoven');
      expect(csl1.given).toBe('Ludwig');
    });

    it('Case 2.2: Vietnamese 3-word, 4-word, compound surnames (Họ kép)', () => {
      // 3-word
      const vn1 = CslJsonMapper.parseStringName('Nguyễn Văn An');
      expect(vn1.family).toBe('Nguyễn');
      expect(vn1.given).toBe('Văn An');

      // 4-word
      const vn2 = CslJsonMapper.parseStringName('Trần Thị Bích Ngọc');
      expect(vn2.family).toBe('Trần');
      expect(vn2.given).toBe('Thị Bích Ngọc');

      // Compound surname (Họ kép: Phan Huy)
      const vn3 = CslJsonMapper.parseStringName('Phan Huy Chú');
      expect(vn3.family).toBe('Phan Huy');
      expect(vn3.given).toBe('Chú');

      // Compound surname (Nguyễn Phúc)
      const vn4 = CslJsonMapper.parseStringName('Nguyễn Phúc Ánh');
      expect(vn4.family).toBe('Nguyễn Phúc');
      expect(vn4.given).toBe('Ánh');
    });

    it('Case 2.3: Mononyms & Institutional / Organization authors', () => {
      // Mononyms (Plato, Euclid)
      const mono = CslJsonMapper.parseStringName('Plato');
      expect(mono.family).toBe('Plato');

      const euclid = CslJsonMapper.parseStringName('Euclid');
      expect(euclid.family).toBe('Euclid');

      // Institutional authors
      const who = CslJsonMapper.parseStringName('World Health Organization');
      expect(who.literal).toBe('World Health Organization');
      expect(who.family).toBeUndefined();

      const vnOrg = CslJsonMapper.parseStringName(
        'Viện Hàn lâm Khoa học và Công nghệ Việt Nam',
      );
      expect(vnOrg.literal).toBe('Viện Hàn lâm Khoa học và Công nghệ Việt Nam');
    });

    it('Case 2.4: Scraped author strings with footnote superscripts, emails, degrees, affiliations', () => {
      // Dirty inputs often produced by PDF OCR
      expect(cleanAuthorName('Ashish Vaswani 1,2*')).toBe('Ashish Vaswani');
      expect(cleanAuthorName('Noam Shazeer *†')).toBe('Noam Shazeer');
      expect(cleanAuthorName('Niki Parmar <niki@google.com>')).toBe(
        'Niki Parmar',
      );
      expect(cleanAuthorName('Prof. Dr. Yann LeCun, PhD')).toBe('Yann LeCun');

      // Discarding pure noise keywords extracted from PDF headers
      const authorsString =
        'Ashish Vaswani, Noam Shazeer, A B S T R A C T, Visual Geometry Group, Niki Parmar';
      const parsed = splitAuthorString(authorsString);
      expect(parsed).toEqual(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar']);
      expect(parsed).not.toContain('A B S T R A C T');
      expect(parsed).not.toContain('Visual Geometry Group');
    });
  });

  // =========================================================================
  // SCENARIO 3: Academic Abstract Normalization & Math Formula Preservation
  // =========================================================================
  describe('Scenario 3: Abstract Sanitization & Math/LaTeX Integrity', () => {
    it('Case 3.1: Preserves inline LaTeX math ($...$) and symbols intact', () => {
      const raw =
        'We prove that $f(x) = \\sum_{i=1}^n w_i x_i + b$ achieves $O(n \\log n)$ efficiency in $\\mathbb{R}^d$.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(raw);
    });

    it('Case 3.2: Preserves display equations ($$...$$) and equation environments', () => {
      const raw =
        'The core loss is defined as: $$\\mathcal{L}_{G} = \\mathbb{E}[\\log D(x)]$$ and converges monotonically.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toContain(
        '$$\\mathcal{L}_{G} = \\mathbb{E}[\\log D(x)]$$',
      );
    });

    it('Case 3.3: Strips XML/HTML markup (JATS, <p>, <b>) while preserving math tags', () => {
      const jatsXml =
        '<jats:p>We study <jats:italic>deep architectures</jats:italic> where <jats:inline-formula><jats:tex-math>\\alpha > 0</jats:tex-math></jats:inline-formula>.</jats:p>';
      const cleaned = cleanAbstractText(jatsXml);
      expect(cleaned).toBe('We study deep architectures where $\\alpha > 0$.');
    });

    it('Case 3.4: Strips redundant prefix labels (e.g. ABSTRACT:, Summary:)', () => {
      const raw =
        'ABSTRACT: In this paper, we explore autonomous agent reasoning loops.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'In this paper, we explore autonomous agent reasoning loops.',
      );
    });
  });

  // =========================================================================
  // SCENARIO 4: Persistent Identifiers (DOIs, arXiv, ISBN)
  // =========================================================================
  describe('Scenario 4: Academic Identifier Parsing & Canonical Normalization', () => {
    it('Case 4.1: Normalizes diverse DOI formats (URL, doi: prefix, uppercase)', () => {
      expect(normalizeDoi('https://doi.org/10.1038/s41586-021-03819-2')).toBe(
        '10.1038/s41586-021-03819-2',
      );
      expect(normalizeDoi('doi:10.1038/s41586-021-03819-2')).toBe(
        '10.1038/s41586-021-03819-2',
      );
      expect(normalizeDoi('10.1038/S41586-021-03819-2 ')).toBe(
        '10.1038/s41586-021-03819-2',
      );
    });

    it('Case 4.2: Normalizes arXiv IDs across versioned and unversioned schemas', () => {
      expect(normalizeArxivId('arXiv:1706.03762v7')).toBe('1706.03762v7');
      expect(
        normalizeArxivId('arXiv:1706.03762v7', { stripVersion: true }),
      ).toBe('1706.03762');
      expect(normalizeArxivId('http://arxiv.org/abs/1706.03762')).toBe(
        '1706.03762',
      );
    });

    it('Case 4.3: Validates ISBN-10, ISBN-13 and PMID normalization', () => {
      expect(normalizeIsbn('978-0-262-03384-8')).toBe('9780262033848');
      expect(normalizeIsbn('9780262033848')).toBe('9780262033848');
      expect(normalizePmid('pmid: 29322995')).toBe('29322995');
    });
  });

  // =========================================================================
  // SCENARIO 5: Type Conversion Invariants & Zero Data Loss
  // =========================================================================
  describe('Scenario 5: Schema Invariants, Type Conversion & Zero Data Loss', () => {
    it('Case 5.1: Converts preprint to journalArticle upon peer-reviewed publication', () => {
      const preprint = {
        itemType: 'preprint',
        title: 'Attention Is All You Need',
        creators: [{ name: 'Vaswani, Ashish', creatorType: 'author' }],
        repository: 'arXiv',
        archiveID: 'arXiv:1706.03762',
        date: '2017',
      };

      const preview = itemTransformer.previewConversion(
        preprint,
        'journalArticle',
        {
          retainUnmappedInExtra: true,
        },
      );

      expect(preview.targetType).toBe('journalArticle');
      const projected = preview.projectedItem as Record<string, any>;
      expect(projected.title).toBe('Attention Is All You Need');
      // archiveID is preserved directly as persistent academic identifier
      expect(projected.archiveID).toBe('arXiv:1706.03762');
      // Unmapped type-specific fields (e.g. genre) are safely retained in extra
      expect(projected.extra).toContain('Genre: preprint');
    });

    it('Case 5.2: Converts journalArticle to patent - retains volume and issue in extra', () => {
      const article = {
        itemType: 'journalArticle',
        title: 'Transformer Neural Network Architecture',
        volume: '42',
        issue: '3',
        pages: '100-115',
      };

      const preview = itemTransformer.previewConversion(article, 'patent', {
        retainUnmappedInExtra: true,
      });

      expect(preview.targetType).toBe('patent');
      const projected = preview.projectedItem as Record<string, any>;
      expect(projected.volume).toBeUndefined();
      expect(projected.issue).toBeUndefined();
      expect(projected.extra).toContain('Volume: 42');
      expect(projected.extra).toContain('Issue: 3');
    });

    it('Case 5.3: Partial updates do not wipe existing creators or unrelated fields', () => {
      const partialUpdate = {
        volume: '43',
        pages: '200-210',
      };

      const sanitized = schemaValidator.validateAndSanitizeItem(
        'journalArticle',
        partialUpdate,
      );
      expect(sanitized.valid).toBe(true);
      expect(sanitized.sanitizedItem.volume).toBe('43');
      // creators must remain undefined so existing creators are preserved during PATCH
      expect(sanitized.sanitizedItem.creators).toBeUndefined();
    });
  });

  // =========================================================================
  // SCENARIO 6: Citation Formatting across Standards (APA, IEEE, Nature, BibTeX)
  // =========================================================================
  describe('Scenario 6: Citation Key & Multi-Style CSL Output Generation', () => {
    const canonicalItem = buildMockLibraryItem({
      id: '01920b92-2222-7222-8222-222222222222',
      citationKey: 'vaswani2017attention',
      title: 'Attention Is All You Need',
      itemType: 'journalArticle',
      publicationTitle: 'Advances in Neural Information Processing Systems',
      volume: '30',
      pages: '5998-6008',
      year: 2017,
      doi: '10.5555/3295222.3295349',
      contributors: [
        {
          orderIndex: 0,
          role: 'author',
          firstName: 'Ashish',
          lastName: 'Vaswani',
        },
        {
          orderIndex: 1,
          role: 'author',
          firstName: 'Noam',
          lastName: 'Shazeer',
        },
      ],
    });

    it('Case 6.1: Generates strict Overleaf-compatible BibTeX entry', () => {
      const csl = CslJsonMapper.toCsl(canonicalItem);
      const bibtex = cslEngine.formatBibtex(csl);

      expect(bibtex.toLowerCase()).toContain('@article{vaswani2017attention,');
      expect(bibtex).toContain('Attention');
      expect(bibtex).toContain('Need');
      expect(bibtex).toContain('Vaswani');
    });

    it('Case 6.2: Formats citation in APA 7th style', () => {
      const csl = CslJsonMapper.toCsl(canonicalItem);
      const apaOutput = cslEngine.format(csl, 'apa');
      expect(apaOutput).toBeDefined();
      expect(apaOutput.bibliography).toContain('Vaswani');
      expect(apaOutput.bibliography).toContain('(2017)');
      expect(apaOutput.bibliography).toContain('Attention Is All You Need');
    });

    it('Case 6.3: Formats citation in IEEE style (numeric bracket bibliography)', () => {
      const csl = CslJsonMapper.toCsl(canonicalItem);
      const ieeeOutput = cslEngine.format(csl, 'ieee');
      expect(ieeeOutput).toBeDefined();
      expect(ieeeOutput.bibliography).toContain('A. Vaswani');
      expect(ieeeOutput.bibliography).toContain('Attention Is All You Need');
    });

    it('Case 6.4: Formats citation in Nature style', () => {
      const csl = CslJsonMapper.toCsl(canonicalItem);
      const natureOutput = cslEngine.format(csl, 'nature');
      expect(natureOutput).toBeDefined();
      expect(natureOutput.bibliography).toContain('Vaswani');
    });
  });

  // =========================================================================
  // SCENARIO 7: Metadata Reconciliation & Multi-Provider Ingestion
  // =========================================================================
  describe('Scenario 7: Multi-Source Reconciliation & Conflict Resolution', () => {
    it('Case 7.1: Higher confidence provider takes precedence on conflicting title', () => {
      const candidate1: MetadataCandidate = {
        id: 'cand-1',
        sourceProvider: 'arXiv',
        confidenceScore: 0.75,
        fetchedAt: new Date().toISOString(),
        metadata: {
          title: 'Attention Is All You Need (Preliminary Preprint)',
          year: 2017,
        },
      };

      const candidate2: MetadataCandidate = {
        id: 'cand-2',
        sourceProvider: 'CrossRef',
        confidenceScore: 0.95,
        fetchedAt: new Date().toISOString(),
        metadata: {
          title: 'Attention Is All You Need',
          year: 2017,
          doi: '10.5555/3295222.3295349',
        },
      };

      const result = reconciliationService.reconcile([candidate1, candidate2]);
      expect(result.metadata.title).toBe('Attention Is All You Need');
      expect(result.metadata.doi).toBe('10.5555/3295222.3295349');
    });

    it('Case 7.2: User explicit override always trumps external provider data', () => {
      const crossrefCand: MetadataCandidate = {
        id: 'cand-crossref',
        sourceProvider: 'CrossRef',
        confidenceScore: 0.95,
        fetchedAt: new Date().toISOString(),
        metadata: {
          title: 'Standard CrossRef Title',
          volume: '10',
        },
      };

      const userOverrideCand: MetadataCandidate = {
        id: 'cand-user',
        sourceProvider: 'UserOverride',
        confidenceScore: 1.0,
        fetchedAt: new Date().toISOString(),
        metadata: {
          title: 'User Customized Curated Title',
        },
      };

      const result = reconciliationService.reconcile([
        crossrefCand,
        userOverrideCand,
      ]);
      expect(result.metadata.title).toBe('User Customized Curated Title');
      // Non-conflicting fields from CrossRef are still populated
      expect(result.metadata.volume).toBe('10');
    });
  });

  // =========================================================================
  // SCENARIO 8: Resilience against Malformed Data & Security Edge Cases
  // =========================================================================
  describe('Scenario 8: Resilience against Malformed Metadata & Security Invariants', () => {
    it('Case 8.1: Sanitizes potential XSS HTML payloads in titles', () => {
      const maliciousTitle =
        '<script>alert("XSS")</script>Neural Machine Translation';
      const sanitized = sanitizeItemTitle(maliciousTitle);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).toBe('Neural Machine Translation');
    });

    it('Case 8.2: Demotes unknown custom fields into extra without rejecting the item', () => {
      const payload = {
        title: 'Quantum Computing Frontiers',
        itemType: 'journalArticle',
        customLaboratoryCode: 'LAB-NYC-2026',
        internalGrantNumber: 'NSF-998877',
      };

      const result = schemaValidator.validateAndSanitizeItem(
        'journalArticle',
        payload,
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.title).toBe(payload.title);
      expect(result.sanitizedItem.extra).toContain(
        'customLaboratoryCode: LAB-NYC-2026',
      );
      expect(result.sanitizedItem.extra).toContain(
        'internalGrantNumber: NSF-998877',
      );
    });
  });
});
