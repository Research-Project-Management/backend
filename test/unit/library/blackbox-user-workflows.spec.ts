import { BibliographyFormatRegistry } from '@/modules/library/ingestion/parsers/bibliography-format.registry';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { XmlLegacyFormatsParser } from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { parseFeedXml } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import {
  normalizeDoi, normalizeArxivId, normalizeIsbn, isValidIsbnChecksum, normalizePmid, normalizePmcid, normalizeIssn,
  deriveDoiFromPublisherUrl, deriveDirectPdfUrl, yearFromArxivId, generateCitationKey, RegexExtractor, normalizeTags,
  resolveArxivTaxonomyTag, formatAttachmentFilename, buildAnnotationSortIndex, parseAnnotationSortIndex,
  buildTipTapDocFromText, extractPlainTextFromTipTap, stripNoteHtml, SearchQueryEngine, isInstitutionName,
  isVietnameseName, cleanAuthorName, harmonizeBibliographicFields,
} from '@/modules/library/core';
import { PdfMetadataExtractor } from '@/modules/library/extraction/providers/pdf-metadata.extractor';
import { LayoutExtractor } from '@/modules/library/extraction/providers/layout.extractor';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotations.domain';
import {
  DuplicatePolicy, calculateTitleSimilarity, hasConflictingPartOrSupplementMarkers, isGenericBoilerplateTitle, firstAuthorMatches,
} from '@/modules/library/ingestion/domain/deduplication.domain';
import {
  applyMetadataAndProvenanceBackfill, computeMergedTopLevelAndPrimaryMeta, planMergedItemRelations,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { TypesService } from '@/modules/library/catalog/services/schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/services/item.transformer';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.policy';
import { ReadingStatus } from '@/modules/library/catalog/types/catalog.types';
import {
  TreeEngine, pickPreferredMergedState, mergeScrollPosition, shouldAutoAdvanceToReading, isValidStateTransition,
} from '@/modules/library/catalog/domain/state.domain';
import {
  buildImportItemPayload, buildCommandCreateInput, buildCommandUpdateInput,
} from '@/modules/library/catalog/domain/item-command.mapper';
import { extractItemCitationAliases, resolveEmittedCitationEntries } from '@/modules/library/citation/domain/citation.domain';
import { resolveExportFormatStrategy, formatItemsAsBibtex } from '@/modules/library/citation/domain/export-format.mapper';
import { CitationService } from '@/modules/library/citation/services/citation.service';

describe('Black-Box Zotero / Mendeley / Paperpile Community User Workflows', () => {
  describe('Persona 1: Literature Collector & Importer (Messy Multi-Format & Identifier Workflows)', () => {
    const registry = new BibliographyFormatRegistry(
      new BibtexParser(), new RisParser(), new CslParser(), new XmlLegacyFormatsParser(),
    );

    it('P1.1: parses BibTeX with @string macros, nested LaTeX accents, corporate double-braced authors, and multiline abstract', async () => {
      const messyBibtex = `
        @STRING{cvpr = "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)"}
        @inproceedings{schrodinger2024quantum,
          author = {Schr{\\"o}dinger, Erwin and {World Health Organization} and Garc{\\'i}a-M{\\'a}rquez, Gabriel and Łukasiewicz, Jan},
          title = {{Deep Learning for {COVID-19} Chest X-Ray Triage: A Multi-Center Study}},
          booktitle = cvpr, year = {2024}, month = jun, pages = {1024--1035},
          doi = {https://doi.org/10.1109/CVPR52733.2024.00102},
          abstract = {Line one of abstract with \\textbf{bold} text
            and line two with \\emph{italics} and LaTeX umlaut {\\"u}.}
        }
      `;
      expect(registry.detectRecordFormat(messyBibtex)).toBe('BIBTEX');
      const envelopes = await registry.parseEnvelopes(messyBibtex);
      expect(envelopes).toHaveLength(1);
      const raw = envelopes[0].rawMetadata;
      expect(raw.title).toContain('COVID-19');
      expect(raw.publicationTitle).toContain('Computer Vision and Pattern Recognition');
      expect(raw.year).toBe(2024);
      expect(raw.pages).toBe('1024-1035');
      const authors = raw.authors as string[];
      expect(authors.some((a) => a.includes('Schrödinger'))).toBe(true);
      expect(authors.some((a) => a.includes('World Health Organization'))).toBe(true);
      expect(authors.some((a) => a.includes('García-Márquez'))).toBe(true);
    });

    it('P1.2: parses RIS exports with fallback venue tags (T2/JF/JO), mixed AU/A1 author tags, split SP/EP pages, and Y1/PY dates', async () => {
      const messyRis = [
        'TY  - CONF', 'TI  - Attention Is All You Need in Clinical NLP', 'AU  - Vaswani, Ashish', 'A1  - Shazeer, Noam',
        'T2  - Advances in Neural Information Processing Systems', 'Y1  - 2023/12/15/winter', 'VL  - 36', 'IS  - 4',
        'SP  - 500', 'EP  - 512', 'DO  - doi:10.5555/3295222.3295349', 'KW  - Transformers', 'KW  - Clinical NLP', 'ER  - ',
      ].join('\r\n');

      expect(registry.detectRecordFormat(messyRis)).toBe('RIS');
      const envelopes = await registry.parseEnvelopes(messyRis);
      expect(envelopes).toHaveLength(1);
      const rec = envelopes[0].rawMetadata;
      expect(rec.itemType).toBe('conferencePaper');
      expect(rec.year).toBe(2023);
      expect(rec.pages).toBe('500-512');
      expect(rec.doi).toBe('10.5555/3295222.3295349');
      expect(rec.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
      expect(rec.keywords).toEqual(['Transformers', 'Clinical NLP']);
    });

    it('P1.3: parses PubMed MEDLINE/NBIB format with FAU, JT, DP, LID [doi], PMID, PMC, and MH MeSH headings', async () => {
      const nbib = [
        'PMID- 38123456', 'PMC - PMC10876543', 'TI  - CRISPR-Cas9 gene editing for sickle cell disease: a phase 3 trial.',
        'FAU - Frangoul, Haydar', 'FAU - Altshuler, David', 'JT  - The New England journal of medicine', 'DP  - 2024 Apr 25',
        'VI  - 390', 'IP  - 16', 'PG  - 1489-1501', 'LID - 10.1056/NEJMoa2309676 [doi]',
        'AB  - BACKGROUND: Sickle cell disease is caused by a point mutation.',
        'MH  - Anemia, Sickle Cell/*genetics/*therapy', 'MH  - CRISPR-Cas Systems/*therapeutic use',
      ].join('\n');

      expect(registry.detectRecordFormat(nbib)).toBe('MEDLINE');
      const envelopes = await registry.parseEnvelopes(nbib);
      expect(envelopes).toHaveLength(1);
      const rec = envelopes[0].rawMetadata;
      expect(rec.pmid).toBe('38123456');
      expect(rec.pmcid).toBe('PMC10876543');
      expect(rec.doi).toBe('10.1056/nejmoa2309676');
      expect(rec.year).toBe(2024);
      expect(rec.volume).toBe('390');
      expect(rec.issue).toBe('16');
      expect(rec.pages).toBe('1489-1501');
    });

    it('P1.4: parses EndNote XML, MODS XML, Zotero RDF, and Zotero CSV exports accurately', async () => {
      const endnoteXml = `<xml><records><record>
        <ref-type name="Journal Article">17</ref-type>
        <contributors><authors><author> Hinton, Geoffrey E. </author><author>LeCun, Yann</author></authors></contributors>
        <titles><title>Deep Learning</title><secondary-title>Nature</secondary-title></titles>
        <dates><year>2015</year></dates><volume>521</volume><number>7553</number><pages>436-444</pages>
        <electronic-resource-num>10.1038/nature14539</electronic-resource-num>
      </record></records></xml>`;
      const endnoteEnv = await registry.parseEnvelopes(endnoteXml);
      expect(endnoteEnv[0].rawMetadata.title).toBe('Deep Learning');
      expect(endnoteEnv[0].rawMetadata.doi).toBe('10.1038/nature14539');
      expect(endnoteEnv[0].rawMetadata.year).toBe(2015);

      const modsXml = `<modsCollection xmlns="http://www.loc.gov/mods/v3"><mods>
        <titleInfo><title>A Mathematical Theory of Communication</title></titleInfo>
        <name type="personal"><namePart type="given">Claude E.</namePart><namePart type="family">Shannon</namePart><role><roleTerm>aut</roleTerm></role></name>
        <originInfo><dateIssued>1948-07</dateIssued></originInfo>
        <identifier type="doi">10.1002/j.1538-7305.1948.tb01338.x</identifier>
      </mods></modsCollection>`;
      const modsEnv = await registry.parseEnvelopes(modsXml);
      expect(modsEnv[0].rawMetadata.title).toBe('A Mathematical Theory of Communication');
      expect(modsEnv[0].rawMetadata.year).toBe(1948);

      const csvContent = [
        '"Item Type","Publication Year","Author","Title","Publication Title","DOI","Volume","Issue","Pages"',
        '"journalArticle","2021","Jumper, John; Hassabis, Demis","Highly accurate protein structure prediction with AlphaFold","Nature","10.1038/s41586-021-03819-2","596","7873","583-589"',
      ].join('\n');
      const csvEnv = await registry.parseEnvelopes(csvContent);
      expect(csvEnv[0].rawMetadata.title).toContain('AlphaFold');
      expect(csvEnv[0].rawMetadata.doi).toBe('10.1038/s41586-021-03819-2');
      expect(csvEnv[0].rawMetadata.authors).toEqual(['Jumper, John', 'Hassabis, Demis']);
    });

    it('P1.5: normalizes messy DOIs, extracts DOIs from publisher landing URLs, and derives direct PDF URLs', () => {
      expect(normalizeDoi('https://dx.doi.org/10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM879>3.0.CO;2-2.')).toBe(
        '10.1002/(sici)1097-0258(19980815/30)17:15/16<1661::aid-sim879>3.0.co;2-2',
      );
      expect(deriveDoiFromPublisherUrl('https://www.nature.com/articles/s41586-021-03819-2')).toBe('10.1038/s41586-021-03819-2');
      expect(deriveDoiFromPublisherUrl('https://dl.acm.org/doi/pdf/10.1145/3442188.3445922?download=true')).toBe('10.1145/3442188.3445922');
      expect(deriveDoiFromPublisherUrl('https://link.springer.com/chapter/10.1007/978-3-030-58452-8_13')).toBe('10.1007/978-3-030-58452-8_13');
      expect(deriveDirectPdfUrl('https://arxiv.org/abs/2303.08774v2')).toBe('https://arxiv.org/pdf/2303.08774v2.pdf');
      expect(deriveDirectPdfUrl('https://www.biorxiv.org/content/10.1101/2023.05.10.540123v1')).toBe(
        'https://www.biorxiv.org/content/10.1101/2023.05.10.540123v1.full.pdf',
      );
    });

    it('P1.6: normalizes modern & legacy arXiv IDs (preserving or stripping version), ISBN-10/13 checksums, ISSN, PMID, and PMCID', () => {
      expect(normalizeArxivId('arXiv:2303.08774v3 [cs.CL]')).toBe('2303.08774v3');
      expect(normalizeArxivId('arXiv:2303.08774v3 [cs.CL]', { stripVersion: true })).toBe('2303.08774');
      expect(normalizeArxivId('https://arxiv.org/pdf/hep-th/9901001v2.pdf', { stripVersion: true })).toBe('hep-th/9901001');
      expect(yearFromArxivId('2303.08774')).toBe(2023);
      expect(yearFromArxivId('hep-th/9901001')).toBe(1999);
      expect(normalizeIsbn('ISBN-10: 0-306-40615-2')).toBe('0306406152');
      expect(isValidIsbnChecksum('0306406152')).toBe(true);
      expect(isValidIsbnChecksum('0306406153')).toBe(false);
      expect(isValidIsbnChecksum('043942089X')).toBe(true);
      expect(normalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
      expect(isValidIsbnChecksum('9780306406157')).toBe(true);
      expect(normalizeIssn('ISSN 0378-5955')).toBe('0378-5955');
      expect(normalizePmid('PMID: 34567890')).toBe('34567890');
      expect(normalizePmcid('PMC9876543')).toBe('PMC9876543');
    });

    it('P1.7: rejects bogus PDF metadata titles (Microsoft Word, dvips TeX output, bare DOI, untitled) and extracts real metadata from PDF text', () => {
      expect(PdfMetadataExtractor.isBogusTitle('Microsoft Word - Document1.docx')).toBe(true);
      expect(PdfMetadataExtractor.isBogusTitle('dvips(k) 5.996 Copyright 2016 Radical Eye Software')).toBe(true);
      expect(PdfMetadataExtractor.isBogusTitle('untitled')).toBe(true);
      expect(PdfMetadataExtractor.isBogusTitle('10.1038/s41586-021-03819-2')).toBe(true);
      expect(PdfMetadataExtractor.isBogusTitle('Scaling Laws for Neural Language Models')).toBe(false);

      const samplePdfFirstPage = [
        'arXiv:2005.14165v4 [cs.CL] 22 Jul 2020',
        'Language Models are Few-Shot Learners',
        'Tom B. Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah',
        'OpenAI, San Francisco, CA 94110, USA',
        'Abstract—Recent work has demonstrated substantial gains on many NLP tasks and benchmarks by pre-training on a large corpus of text followed by fine-tuning on a specific task.',
        'Keywords: Large Language Models, Few-Shot Learning, Transformer Architecture, In-Context Learning.',
        '1 Introduction',
        'As noted by Vaswani et al. [1] (doi:10.5555/3295222.3295349, arXiv:1706.03762), self-attention scales quadratically.',
      ].join('\n');

      const regexExtracted = RegexExtractor.scan(samplePdfFirstPage);
      expect(regexExtracted.arxivId).toBe('2005.14165v4');
      expect(regexExtracted.primaryCategory).toBe('cs.CL');
      expect(regexExtracted.keywords).toEqual(expect.arrayContaining(['Large Language Models', 'Few-Shot Learning']));
      expect(regexExtracted.abstract).toContain('substantial gains on many NLP tasks');

      const layoutPlain = LayoutExtractor.extractFromPlainText(samplePdfFirstPage);
      expect(layoutPlain.title).toBe('Language Models are Few-Shot Learners');
      expect(layoutPlain.authors).toEqual(expect.arrayContaining(['Tom B. Brown', 'Benjamin Mann']));
      expect(layoutPlain.year).toBe(2020);
    });

    it('P1.8: handles Vietnamese names, corporate authors, and Vancouver names without corrupting surname/givenName order', () => {
      expect(isVietnameseName('Nguyễn Văn An')).toBe(true);
      expect(isVietnameseName('Trần Thị Minh Châu')).toBe(true);
      expect(isVietnameseName('John Smith')).toBe(false);
      expect(isInstitutionName('World Health Organization')).toBe(true);
      expect(isInstitutionName('National Institute of Standards and Technology')).toBe(true);
      expect(cleanAuthorName('Prof. Dr. Geoffrey E. Hinton (corresponding author) <hinton@cs.toronto.edu>')).toBe('Geoffrey E. Hinton');
    });
  });

  describe('Persona 2: Curator & Organizer (Deduplication, Field-Locked Merge, Type Conversion, Tags, Retractions)', () => {
    it('P2.1: detects duplicates across Preprint -> Journal Article while guarding against Part I vs Part II and Erratum/Reply false positives', () => {
      expect(
        calculateTitleSimilarity(
          'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
          'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.',
        ),
      ).toBe(1);
      expect(firstAuthorMatches('Lewis, Patrick', 'Patrick Lewis')).toBe(true);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Foundations of Statistical Mechanics, Part I: Equilibrium',
          'Foundations of Statistical Mechanics, Part II: Non-Equilibrium',
        ),
      ).toBe(true);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Room-temperature superconductivity in a carbonaceous sulfur hydride',
          'Retraction Note: Room-temperature superconductivity in a carbonaceous sulfur hydride',
        ),
      ).toBe(true);
      expect(isGenericBoilerplateTitle('Editorial')).toBe(true);
      expect(isGenericBoilerplateTitle('Foreword')).toBe(true);
      expect(isGenericBoilerplateTitle('Attention Is All You Need')).toBe(false);

      const dupPolicy = new DuplicatePolicy();
      const exactMatch = dupPolicy.evaluate(
        { title: 'Deep Residual Learning for Image Recognition', doi: 'https://doi.org/10.1109/CVPR.2016.90' },
        [
          {
            id: 'item-existing-1', title: 'Deep Residual Learning for Image Recognition',
            year: 2016, doi: '10.1109/cvpr.2016.90', authors: ['Kaiming He', 'Xiangyu Zhang'],
          },
        ],
      );
      expect(exactMatch.matchType).toBe('EXACT');
      expect(exactMatch.matchReason).toBe('DOI_EXACT');
      expect(exactMatch.targetItemId).toBe('item-existing-1');
    });

    it('P2.2: merges duplicate items respecting lockedFields and user provenance while deduplicating citation graph relations', () => {
      const primaryMeta: Record<string, unknown> = {
        title: 'Custom User-Edited Title (Locked)', publisher: 'arXiv', lockedFields: ['title'],
        fieldProvenance: {
          title: { source: 'user', confidence: 1.0, lockedByUser: true, updatedAt: '2025-01-01T00:00:00Z' },
          publisher: { source: 'arxiv', confidence: 0.7, updatedAt: '2025-01-01T00:00:00Z' },
        },
      };
      const primaryItem = {
        id: 'target-1', title: 'Custom User-Edited Title (Locked)', citationKey: 'he2016deep',
        doi: null, arxivId: '1512.03385', abstract: null, year: 2015, publicationTitle: 'arXiv', metadata: primaryMeta,
      };
      const duplicateItem = {
        id: 'source-1', title: 'CrossRef Official Title That Should Not Overwrite Locked Field', citationKey: 'he2016cvpr',
        doi: '10.1109/cvpr.2016.90', abstract: 'Backfilled peer-reviewed abstract from CrossRef.', year: 2016,
        publicationTitle: '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
        metadata: {
          title: 'CrossRef Official Title That Should Not Overwrite Locked Field',
          abstract: 'Backfilled peer-reviewed abstract from CrossRef.', publisher: 'IEEE', volume: '1', pages: '770-778',
          fieldProvenance: {
            title: { source: 'crossref', confidence: 0.95, updatedAt: '2025-02-01T00:00:00Z' },
            abstract: { source: 'crossref', confidence: 0.95, updatedAt: '2025-02-01T00:00:00Z' },
            publisher: { source: 'crossref', confidence: 0.95, updatedAt: '2025-02-01T00:00:00Z' },
          },
        },
      };

      const backfillFields: Record<string, unknown> = {};
      const scalarSelections: Record<string, unknown> = {};
      applyMetadataAndProvenanceBackfill({
        primary: primaryItem, duplicates: [duplicateItem], scalarSelections, primaryMeta, backfillFields,
      });

      expect(backfillFields.title).toBeUndefined();
      expect(backfillFields.abstract).toBe('Backfilled peer-reviewed abstract from CrossRef.');
      expect(backfillFields.pages).toBe('770-778');

      const topLevelData = computeMergedTopLevelAndPrimaryMeta({
        primary: primaryItem, backfillFields, scalarSelections, primaryMeta,
      });
      expect(topLevelData.abstract).toBe('Backfilled peer-reviewed abstract from CrossRef.');
      expect(topLevelData.publicationTitle).toContain('Computer Vision and Pattern Recognition');

      const relationPlan = planMergedItemRelations(
        [
          { id: 'rel-self', sourceItemId: 'source-1', targetItemId: 'target-1', relationType: 'is_published_version_of' },
          { id: 'rel-dup', sourceItemId: 'source-1', targetItemId: 'other-paper', relationType: 'cites' },
          { id: 'rel-existing', sourceItemId: 'target-1', targetItemId: 'other-paper', relationType: 'cites' },
          { id: 'rel-migrate', sourceItemId: 'source-1', targetItemId: 'novel-paper', relationType: 'cites' },
        ],
        'target-1',
        ['source-1'],
      );
      expect(relationPlan.relationIdsToDelete).toEqual(['rel-self', 'rel-dup']);
      expect(relationPlan.relationUpdates).toEqual([
        { id: 'rel-migrate', sourceItemId: 'target-1', targetItemId: 'novel-paper' },
      ]);
    });

    it('P2.3: converts item types (preprint -> journalArticle -> bookSection) preserving unmapped fields in extra', () => {
      const itemTransformer = new ItemTransformer(new TypesService());
      const preprintToArticle = itemTransformer.previewConversion(
        {
          itemType: 'preprint', title: 'Attention Is All You Need', arxivId: '1706.03762',
          doi: '10.48550/arXiv.1706.03762', date: '2017-06-12',
          creators: [{ firstName: 'Ashish', lastName: 'Vaswani', creatorType: 'author' }],
        },
        'journalArticle',
      );
      expect(preprintToArticle.targetType).toBe('journalArticle');
      expect(preprintToArticle.preservedFields).toContain('title');
      expect(preprintToArticle.projectedItem.title).toBe('Attention Is All You Need');
      expect(String(preprintToArticle.projectedItem.extra)).toContain('arXiv');
      expect(preprintToArticle.unmappedRetained).toBeDefined();

      const articleToBookSection = itemTransformer.previewConversion(
        {
          itemType: 'journalArticle', title: 'The Representation of Knowledge',
          publicationTitle: 'Handbook of Cognitive Science', volume: '2', issue: '4', pages: '101-145', issn: '1234-5678',
          creators: [{ firstName: 'Marvin', lastName: 'Minsky', creatorType: 'author' }],
        },
        'bookSection',
      );
      expect(articleToBookSection.mappedFields).toEqual(
        expect.arrayContaining([expect.objectContaining({ fromField: 'publicationTitle', toField: 'bookTitle' })]),
      );
      expect(articleToBookSection.projectedItem.bookTitle).toBe('Handbook of Cognitive Science');
      expect(String(articleToBookSection.projectedItem.extra)).toContain('Issue: 4');
    });

    it('P2.4: normalizes tags, strips hierarchical tag delimiters, and expands arXiv taxonomy codes into human-readable categories', () => {
      const normalized = normalizeTags(['  Machine Learning  ', 'machine learning', 'cs.CV', 'stat.ML', '#deep-learning;']);
      expect(normalized).toContain('Machine Learning');
      expect(normalized.filter((t) => t.toLowerCase() === 'machine learning')).toHaveLength(1);
      expect(resolveArxivTaxonomyTag('cs.CV')).toBe('Computer Science - Computer Vision and Pattern Recognition');
      expect(resolveArxivTaxonomyTag('cs.CL')).toBe('Computer Science - Computation and Language');
      expect(resolveArxivTaxonomyTag('q-bio.NC')).toBe('Quantitative Biology - Neurons and Cognition');
    });

    it('P2.5: flags retracted papers via Retraction Watch nature classification and supports manual retraction overrides', async () => {
      const itemsMap = new Map<string, Record<string, unknown>>([
        [
          'item-retracted-1',
          {
            id: 'item-retracted-1', userId: 'user-1', doi: '10.1016/s0140-6736(97)11096-0',
            title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children',
            isRetracted: false, metadata: {},
          },
        ],
      ]);
      const mockRepo = {
        findItemById: jest.fn(async (_userId: string, itemId: string) => itemsMap.get(itemId) ?? null),
        updateItemRetraction: jest.fn(
          async (itemId: string, isRetracted: boolean, nature: string | null, details: unknown) => {
            const current = itemsMap.get(itemId);
            if (current) {
              current.isRetracted = isRetracted;
              current.retractionNature = nature;
              current.metadata = { isRetracted, retractionNature: nature, retractionDetails: details };
            }
            return current;
          },
        ),
      };
      const mockScanner = {
        lookup: jest.fn(async () => ({
          status: 'retracted' as const,
          details: {
            nature: 'retraction' as const, reason: 'Falsification/Fabrication of Data; Ethical Violations by Author',
            date: '2010-02-02', noticeDoi: '10.1016/S0140-6736(10)60175-4', source: 'retraction-watch' as const,
          },
        })),
      };

      const retractionService = new RetractionService(mockRepo as never, mockScanner as never, {} as never, {} as never);
      const status = await retractionService.checkItem('user-1', 'item-retracted-1');
      expect(status.isRetracted).toBe(true);
      expect(status.nature).toBe('retraction');
      expect(status.details?.reason).toContain('Falsification/Fabrication of Data');
      expect(itemsMap.get('item-retracted-1')?.isRetracted).toBe(true);
    });
  });

  describe('Persona 3: Advanced Searcher & Saved Search Power User', () => {
    it('P3.1: compiles complex Saved Searches with nested boolean groups, date ranges, creator/tag matching, and isInTheLast', () => {
      const evaluator = new ConditionEvaluatorEngine();
      const descendantMap = new Map<string, string[]>([['col-ml', ['col-nlp', 'col-cv']]]);
      const group = {
        conjunction: 'AND' as const,
        scopeOptions: { showOnlyTopLevel: true, searchSubcollections: true },
        conditions: [
          { field: 'itemType', operator: 'is' as const, value: 'journalArticle' },
          { field: 'year', operator: 'isGreaterThan' as const, value: 2015 },
          { field: 'creator', operator: 'contains' as const, value: 'Vaswani' },
          { field: 'tag', operator: 'is' as const, value: 'Transformer' },
          { field: 'collection', operator: 'is' as const, value: 'col-ml' },
          { field: 'hasAttachment', operator: 'is' as const, value: true },
          { field: 'isRetracted', operator: 'is' as const, value: false },
          { field: 'dateAdded', operator: 'isInTheLast' as const, value: '7 days' },
          {
            conjunction: 'OR' as const,
            conditions: [
              { field: 'title', operator: 'contains' as const, value: 'Transformer' },
              { field: 'title', operator: 'contains' as const, value: 'Diffusion' },
            ],
          },
        ],
      };

      expect(evaluator.extractReferencedCollectionIds(group)).toEqual(['col-ml']);
      const serialized = JSON.stringify(evaluator.compile('user-123', group, undefined, descendantMap));
      expect(serialized).toContain('journalArticle');
      expect(serialized).toContain('Vaswani');
      expect(serialized).toContain('Transformer');
      expect(serialized).toContain('col-nlp');
      expect(serialized).toContain('col-cv');
    });

    it('P3.2: extracts embedded identifiers from free-text search queries, strips diacritics, and blocks ReDoS regex attacks', () => {
      const extracted = SearchQueryEngine.extractIdentifiers(
        'Find doi:10.1038/nature14539 or arXiv:2303.08774v2 and PMID: 38123456 ISBN 978-0-306-40615-7',
      );
      expect(extracted.cleanDoi).toBe('10.1038/nature14539');
      expect(extracted.cleanArxiv).toBe('2303.08774v2');
      expect(extracted.cleanArxivBase).toBe('2303.08774');
      expect(extracted.cleanPmid).toBe('38123456');
      expect(extracted.cleanIsbn).toBe('9780306406157');
      expect(SearchQueryEngine.matchesItemIdentifiersInMemory({ doi: '10.1038/nature14539', title: 'Deep Learning' }, extracted)).toBe(true);
      expect(SearchQueryEngine.stripDiacritics('Schrödinger & Nguyễn Đặng')).toBe('Schrodinger & Nguyen Dang');
      expect(SearchQueryEngine.isSafeRegex('(a+)+$')).toBe(false);
      expect(SearchQueryEngine.parseSafeRegex('/(a+)+$/i')).toBeNull();
      expect(SearchQueryEngine.isSafeRegex('^Transformer\\s+Models$')).toBe(true);
      expect(SearchQueryEngine.parseSafeRegex('/^Transformer\\s+Models$/i')).toBeInstanceOf(RegExp);
    });
  });

  describe('Persona 4: Citation & Export Author (CSL-JSON, APA/IEEE/Vancouver/TCVN, Year Disambiguation, BibTeX/RIS/CSV/Feeds)', () => {
    const citationService = new CitationService();

    it('P4.1: formats single and batch citations in APA 7th, IEEE, Vancouver, and disambiguates same-author same-year as 2024a / 2024b', () => {
      const itemA = {
        id: 'item-2024-a', citationKey: 'smith2024alpha', itemType: 'journalArticle',
        title: 'Alpha Scaling in Large Language Models', year: 2024, journal: 'Journal of AI Research',
        volume: '70', issue: '1', pages: '1-20', doi: '10.1613/jair.1.15001', authors: ['Alice Smith', 'Bob Jones'],
      };
      const itemB = {
        id: 'item-2024-b', citationKey: 'smith2024beta', itemType: 'journalArticle',
        title: 'Beta Alignment in Multimodal Transformers', year: 2024, journal: 'Journal of AI Research',
        volume: '70', issue: '2', pages: '21-40', doi: '10.1613/jair.1.15002', authors: ['Alice Smith', 'Bob Jones'],
      };

      const batchApa = citationService.formatBatch([itemA, itemB], 'apa-7th');
      expect(batchApa.bibliographyText).toContain('2024a');
      expect(batchApa.bibliographyText).toContain('2024b');
      expect(batchApa.citations[0].inText).toContain('2024a');
      expect(batchApa.citations[1].inText).toContain('2024b');

      const batchIeee = citationService.formatBatch([itemA, itemB], 'ieee');
      expect(batchIeee.citations[0].inText).toBe('[1]');
      expect(batchIeee.citations[1].inText).toBe('[2]');
      expect(batchIeee.bibliographyText).toContain('[1]');
      expect(batchIeee.bibliographyText).toContain('[2]');

      const singleVancouver = citationService.formatItem(itemA, 'vancouver');
      expect(singleVancouver.bibliography).toContain('Alpha Scaling in Large Language Models');
    });

    it('P4.2: formats Vietnamese and English references according to TCVN 7539 standard with language-first sorting', () => {
      const vnItem = {
        id: 'vn-1', itemType: 'journalArticle', title: 'Ứng dụng trí tuệ nhân tạo trong chẩn đoán hình ảnh y khoa',
        year: 2024, journal: 'Tạp chí Y học Việt Nam', volume: '535', issue: '2', pages: '45-52',
        authors: ['Nguyễn Văn An', 'Trần Thị Bình'], metadata: { language: 'vi' },
      };
      const enItem = {
        id: 'en-1', itemType: 'journalArticle', title: 'Deep Learning in Medical Imaging',
        year: 2023, journal: 'Medical Image Analysis', volume: '85', pages: '102-115',
        authors: ['John Doe'], metadata: { language: 'en' },
      };

      const batchTcvn = citationService.formatBatch([enItem, vnItem], 'tcvn-7539');
      const vnPos = batchTcvn.bibliographyText.indexOf('Nguyễn Văn An');
      const enPos = batchTcvn.bibliographyText.indexOf('Doe');
      expect(vnPos).toBeGreaterThanOrEqual(0);
      expect(enPos).toBeGreaterThan(vnPos);
    });

    it('P4.3: generates BetterBibTeX-compatible citation keys and resolves merged citation key aliases (tex.ids)', () => {
      expect(
        generateCitationKey({ authors: ['Schrödinger, Erwin'], year: 2024, title: 'The Quantum Cat Paradox in Modern Physics' }),
      ).toBe('schrodinger2024quantum');

      const itemWithMergedKeys = {
        id: 'item-merged-1', citationKey: 'vaswani2017attention',
        extra: 'Citation Key: vaswani2017neurips\ntex.ids: vaswani2017arxiv, vaswani2017nips',
        metadata: { mergedCitationKeys: ['vaswani2017old'] },
      };

      const aliases = extractItemCitationAliases(itemWithMergedKeys);
      expect(aliases).toEqual(
        expect.arrayContaining(['vaswani2017attention', 'vaswani2017neurips', 'vaswani2017arxiv', 'vaswani2017nips', 'vaswani2017old']),
      );

      const emitted = resolveEmittedCitationEntries([itemWithMergedKeys], ['vaswani2017arxiv']);
      expect(emitted.emittedEntries).toHaveLength(1);
      expect(emitted.emittedEntries[0].emitCiteKey).toBe('vaswani2017arxiv');
    });

    it('P4.4: exports items to BibTeX, RIS, CSL-JSON, and CSV (with spreadsheet formula injection neutralization)', () => {
      const maliciousAndRichItem = {
        id: 'export-1', citationKey: 'malicious2024csv', itemType: 'journalArticle', title: '=cmd|\' /C calc\'!A0',
        authors: ['World Health Organization', 'Ada Lovelace'],
        contributors: [
          { fullName: 'World Health Organization', creatorType: 'author', fieldMode: 1 },
          { firstName: 'Ada', lastName: 'Lovelace', creatorType: 'author' },
        ],
        year: 2024, publicationTitle: 'Journal of Security & Testing', volume: '12', issue: '3', pages: '100-110',
        doi: '10.1000/sec.2024.01', tags: ['Security', 'CSV Injection'],
      };

      const csvOut = resolveExportFormatStrategy('csv')!.export([maliciousAndRichItem]);
      expect(csvOut.content).toContain('"\'=cmd|');

      const bibtexOut = formatItemsAsBibtex([maliciousAndRichItem], citationService);
      expect(bibtexOut).toContain('@article{malicious2024csv');
      expect(bibtexOut).toContain('{World Health Organization}');

      const risOut = resolveExportFormatStrategy('ris')!.export([maliciousAndRichItem], { citationFormatter: citationService });
      expect(risOut.content).toContain('TY  - JOUR');
      expect(risOut.content).toContain('DO  - 10.1000/sec.2024.01');
      expect(risOut.content).toContain('ER  -');

      const cslOut = JSON.parse(resolveExportFormatStrategy('csl-json')!.export([maliciousAndRichItem]).content) as Array<Record<string, unknown>>;
      expect(cslOut).toHaveLength(1);
      expect(cslOut[0].DOI).toBe('10.1000/sec.2024.01');
    });

    it('P4.5: parses academic RSS 2.0, Atom, and RDF 1.0 (arXiv/Nature) feeds extracting DOIs, arXiv IDs, and creators', () => {
      const arxivRdfFeed = `<?xml version="1.0" encoding="UTF-8"?>
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                 xmlns="http://purl.org/rss/1.0/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/"
                 xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
          <channel><title>cs.CL updates on arXiv.org</title><link>http://arxiv.org/list/cs.CL/recent</link></channel>
          <item rdf:about="http://arxiv.org/abs/2405.12345">
            <title>Scaling Laws for Dense Retrieval (arXiv:2405.12345v1 [cs.CL])</title>
            <link>http://arxiv.org/abs/2405.12345</link>
            <description>arXiv:2405.12345v1 Announce Type: new Abstract: We study scaling laws for dense passage retrieval.</description>
            <dc:creator>Jane Doe, John Smith</dc:creator>
            <dc:date>2024-05-20T00:00:00Z</dc:date>
            <prism:doi>10.48550/arXiv.2405.12345</prism:doi>
          </item>
        </rdf:RDF>`;

      const parsedFeed = parseFeedXml(arxivRdfFeed);
      expect(parsedFeed.feedTitle).toContain('cs.CL updates');
      expect(parsedFeed.entries).toHaveLength(1);
      expect(parsedFeed.entries[0].arxivId).toBe('2405.12345v1');
      expect(parsedFeed.entries[0].doi).toBe('10.48550/arXiv.2405.12345');
      expect(parsedFeed.entries[0].authors).toEqual(expect.arrayContaining(['Jane Doe', 'John Smith']));
    });
  });

  describe('Persona 5: Deep Reader, Annotator, Hierarchical Collections & Collaborative Project Scope', () => {
    it('P5.1: formats attachment filenames using Zotero 7 {{ firstCreator }} templates and round-trips sortIndex & TipTap notes', () => {
      const filename = formatAttachmentFilename('{{ authors }} - {{ year }} - {{ title }}', {
        title: 'Attention Is All You Need: A Survey of Transformers', year: 2024,
        contributors: [
          { firstName: 'Ashish', lastName: 'Vaswani', creatorType: 'author' },
          { firstName: 'Noam', lastName: 'Shazeer', creatorType: 'author' },
          { firstName: 'Niki', lastName: 'Parmar', creatorType: 'author' },
        ],
        publicationTitle: 'Nature Machine Intelligence',
      });
      expect(filename).toBe('Vaswani et al. - 2024 - Attention Is All You Need A Survey of Transformers.pdf');

      const sortIdx = buildAnnotationSortIndex(12, 0.0129, 0, 340);
      expect(sortIdx).toBe('00012|000340|00129');
      expect(parseAnnotationSortIndex(sortIdx)).toEqual({ page: 12, charOffset: 340, y: 0.0129, x: 0 });

      const tiptapDoc = buildTipTapDocFromText('First paragraph of reading note.\n\nSecond paragraph with key takeaway.');
      expect(extractPlainTextFromTipTap(tiptapDoc)).toContain('First paragraph of reading note.');
      expect(extractPlainTextFromTipTap(tiptapDoc)).toContain('Second paragraph with key takeaway.');
      expect(stripNoteHtml('<p>Hello <b>world</b><script>alert(1)</script></p>')).toBe('Hello world');
    });

    it('P5.2: normalizes PDF/EPUB annotations (highlights, area rectangles, hex colors, page bounds)', () => {
      const normalizer = new AnnotationNormalizer();
      const normalizedCreate = normalizer.normalizeCreateData({
        type: 'highlight', color: '#FFEB3B', pageIndex: 2, pageLabel: 'iii',
        quoteText: 'Self-attention relates different positions of a single sequence.',
        comment: 'Core definition of <b>self-attention</b><script>evil()</script>',
        tags: ['  Self-Attention ', 'self-attention'], rectCoords: [480.0, 524.8, 72.5, 512.3],
      });

      expect(normalizedCreate.type).toBe('highlight');
      expect(normalizedCreate.color).toBe('#ffeb3b');
      expect(normalizedCreate.pageIndex).toBe(2);
      expect(normalizedCreate.quoteText).toContain('Self-attention relates');
      expect(normalizedCreate.comment).toBe('Core definition of self-attention');
      expect(normalizedCreate.rectCoords).toEqual([72.5, 512.3, 480.0, 524.8]);
    });

    it('P5.3: builds hierarchical collection trees with recursive counts and prevents circular collection moves', () => {
      const treeEngine = new TreeEngine();
      const flatCollections = [
        { id: 'col-root', name: 'AI Research', parentId: null, collectionItems: ['i1', 'i2'] },
        { id: 'col-sub1', name: 'NLP', parentId: 'col-root', collectionItems: ['i2', 'i3'] },
        { id: 'col-sub2', name: 'Transformers', parentId: 'col-sub1', collectionItems: ['i4'] },
      ];

      const tree = treeEngine.buildTree(flatCollections);
      expect(tree).toHaveLength(1);
      expect(tree[0].recursiveItemCount).toBe(4);
      expect(treeEngine.detectCycle(flatCollections, 'col-root', 'col-sub2')).toBe(true);
      expect(() => treeEngine.assertNoCycle(flatCollections, 'col-root', 'col-sub2')).toThrow(/Circular collection hierarchy detected/);
      expect(treeEngine.detectCycle(flatCollections, 'col-sub2', 'col-root')).toBe(false);
    });

    it('P5.4: isolates Personal vs Project library scope payloads and monotonically merges reading progress', () => {
      const mergedState = pickPreferredMergedState([
        { userId: 'u1', itemId: 'i1', readStatus: 'unread', isStarred: false, currentPage: 2, rating: 3 },
        { userId: 'u1', itemId: 'i2', readStatus: 'reading', isStarred: true, currentPage: 14, rating: 5 },
      ]);
      expect(mergedState.readStatus).toBe('reading');
      expect(mergedState.isStarred).toBe(true);
      expect(mergedState.maxCurrentPage).toBe(14);
      expect(mergedState.maxRating).toBe(5);
      expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 15)).toBe(true);
      expect(isValidStateTransition(ReadingStatus.UNREAD, ReadingStatus.READING)).toBe(true);

      const mergedScroll = mergeScrollPosition({ page: 4, scrollTop: 120, progress: 25 }, { page: 9, scrollTop: 340, progress: 60 }, 'att-pdf-1') as Record<string, unknown>;
      expect(mergedScroll.page).toBe(9);
      expect(mergedScroll.progress).toBe(60);
      expect(mergedScroll.byAttachment).toBeDefined();

      const projectUuid = '550e8400-e29b-41d4-a716-446655440099';
      const createInput = buildCommandCreateInput('user-123', {
        title: 'Collaborative Project Paper', itemType: 'journalArticle', doi: '10.1038/s41586-021-03819-2',
        authors: ['John Jumper', 'Demis Hassabis'], tags: ['AlphaFold', 'Protein Folding'], projectId: projectUuid, collectionId: 'col-proteins',
      });
      expect(createInput.createData.createdById).toBe('user-123');
      expect(createInput.createData.spaceId).toBe(projectUuid);
      expect(createInput.createData.doi).toBe('10.1038/s41586-021-03819-2');

      const updateInput = buildCommandUpdateInput(
        'user-123', { id: 'item-1', title: 'Old Title', itemType: 'journalArticle', year: 2023 },
        { title: 'Updated Collaborative Paper Title', isRetracted: true },
      );
      expect(updateInput.updateData.title).toBe('Updated Collaborative Paper Title');
      expect(updateInput.updateData.isRetracted).toBe(true);

      const importPayload = buildImportItemPayload(
        {
          title: 'Imported Paper from Personal to Project', itemType: 'conferencePaper', year: 2024,
          contributors: [{ firstName: 'Yann', lastName: 'LeCun', creatorType: 'author' }],
          itemTags: [{ tag: { name: 'Self-Supervised Learning' } }],
        },
        'user-123',
      );
      expect(importPayload.itemType).toBe('conferencePaper');
      expect(importPayload.creators?.[0].lastName).toBe('LeCun');
      expect(importPayload.tags).toEqual(['Self-Supervised Learning']);
      expect(importPayload.uploadedById).toBe('user-123');

      const harmonized = harmonizeBibliographicFields(
        { itemType: 'conferencePaper', title: 'Grouped Query Attention', publicationTitle: 'EMNLP 2023', place: 'Singapore' },
        { itemType: 'conferencePaper', syncExtraFields: true },
      );
      expect(harmonized.proceedingsTitle).toBe('EMNLP 2023');
      expect(harmonized.eventPlace).toBe('Singapore');
    });
  });
});
