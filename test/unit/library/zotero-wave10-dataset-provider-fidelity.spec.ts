import { OpenAlexProvider } from '@/modules/library/ingestion/providers/openalex.provider';
import { SemanticScholarProvider } from '@/modules/library/ingestion/providers/semantic-scholar.provider';
import { OpenLibraryProvider } from '@/modules/library/ingestion/providers/openlibrary.provider';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { ReconciliationService } from '@/modules/library/ingestion/services/metadata-reconciliation.service';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { parseCreatorString } from '@/modules/library/shared-kernel/domain/author.domain';
import { stripLatexBraces } from '@/modules/library/shared-kernel/domain/academic-text.domain';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata.types';
import { DuplicateService } from '@/modules/library/ingestion/services/duplicate.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { Prisma } from '@prisma/client';
import { TransactionService } from '@/modules/library/shared-kernel';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { ICatalogGatewayPort } from '@/modules/library/ingestion/types/catalog-gateway.types';

describe('Wave 10: Multi-Dataset & Cross-Provider Metadata Fidelity Audit & Remediation', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const mockJsonResponse = (data: unknown) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => data,
    });
  };

  describe('1. OpenAlexProvider Fidelity (Creators, PMCID/ISBN, arXiv Version, Venue Mapping, Inverted Index)', () => {
    it('parses structured creators (firstName/lastName/fieldMode), preserves PMCID/ISBN/arXiv version, and avoids collapsing spaced hyphens in inverted index', async () => {
      mockJsonResponse({
        id: 'https://openalex.org/W4385245566',
        title: 'Large Language Models in Medicine',
        publication_year: 2024,
        publication_date: '2024-05-14',
        type: 'proceedings-article',
        language: 'en',
        cited_by_count: 85,
        referenced_works: ['W1', 'W2', 'W3'],
        ids: {
          doi: 'https://doi.org/10.1145/3580305.3599572',
          pmid: 'https://pubmed.ncbi.nlm.nih.gov/38123456',
          pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10987654',
          isbn: '978-1-4503-9999-9',
        },
        authorships: [
          { author: { display_name: 'Johannes van der Berg' } },
          { author: { display_name: 'World Health Organization' } },
        ],
        primary_location: {
          source: {
            display_name: 'Proceedings of the 30th ACM SIGKDD Conference',
            host_organization_name: 'Association for Computing Machinery',
            issn_l: '2155-5555',
          },
          pdf_url: 'https://arxiv.org/pdf/2401.12345v3.pdf',
        },
        locations: [
          {
            landing_page_url: 'https://arxiv.org/abs/2401.12345v3',
          },
        ],
        biblio: {
          volume: '1',
          issue: '2',
          first_page: '101',
          last_page: '115',
        },
        abstract_inverted_index: {
          Transformer: [0],
          '-': [1],
          a: [2],
          novel: [3],
          'self-attention': [4],
          architecture: [5],
        },
      });

      const provider = new OpenAlexProvider();
      const res = await provider.resolve({
        query: '10.1145/3580305.3599572',
        queryType: 'DOI',
      });
      expect(res).not.toBeNull();
      const meta = res!.metadata;
      expect(meta.itemType).toBe('conferencePaper');
      expect(meta.proceedingsTitle).toBe(
        'Proceedings of the 30th ACM SIGKDD Conference',
      );
      expect(meta.publicationTitle).toBe(
        'Proceedings of the 30th ACM SIGKDD Conference',
      );
      expect(meta.pmid).toBe('38123456');
      expect(meta.pmcid).toBe('PMC10987654');
      expect(meta.isbn).toBe('9781450399999');
      expect(meta.arxivId).toBe('2401.12345v3');
      expect(meta.archiveId).toBe('arXiv:2401.12345v3');
      expect(meta.abstract).toBe(
        'Transformer - a novel self-attention architecture',
      );
      expect(meta.creators).toHaveLength(2);
      expect(meta.creators![0]).toMatchObject({
        firstName: 'Johannes',
        lastName: 'van der Berg',
        creatorType: 'author',
      });
      expect(meta.creators![1]).toMatchObject({
        lastName: 'World Health Organization',
        fieldMode: 1,
        creatorType: 'author',
      });
    });

    it('maps thesis publisher to university and report publisher to institution', async () => {
      const provider = new OpenAlexProvider();

      mockJsonResponse({
        id: 'https://openalex.org/W111',
        title: 'Quantum Error Correction',
        publication_year: 2023,
        type: 'dissertation',
        primary_location: {
          source: {
            host_organization_name: 'Massachusetts Institute of Technology',
          },
        },
      });
      const thesisRes = await provider.resolve({
        query: '10.1000/mit.1',
        queryType: 'DOI',
      });
      expect(thesisRes?.metadata.itemType).toBe('thesis');
      expect(thesisRes?.metadata.university).toBe(
        'Massachusetts Institute of Technology',
      );

      mockJsonResponse({
        id: 'https://openalex.org/W222',
        title: 'Technical Benchmark Report',
        publication_year: 2023,
        type: 'report',
        primary_location: {
          source: {
            host_organization_name:
              'National Institute of Standards and Technology',
          },
        },
      });
      const reportRes = await provider.resolve({
        query: '10.1000/nist.1',
        queryType: 'DOI',
      });
      expect(reportRes?.metadata.itemType).toBe('report');
      expect(reportRes?.metadata.institution).toBe(
        'National Institute of Standards and Technology',
      );
    });
  });

  describe('2. SemanticScholarProvider Fidelity (Expanded Fields, ItemType Inference, Journal/Venue, Citations)', () => {
    it('extracts publicationDate, journal volume/pages, conference proceedingsTitle, PMCID, citationCount, referenceCount, openAccessPdfUrl, and structured creators', async () => {
      mockJsonResponse({
        paperId: 's2-paper-123',
        title: 'FlashAttention-2: Faster Attention with Better Parallelism',
        year: 2023,
        publicationDate: '2023-07-17',
        venue: 'International Conference on Learning Representations',
        publicationVenue: {
          name: 'International Conference on Learning Representations',
          type: 'conference',
          issn: '2640-3498',
        },
        journal: {
          name: 'ICLR Proceedings',
          volume: '12',
          pages: '1-16',
        },
        publicationTypes: ['Conference', 'JournalArticle'],
        abstract:
          'We propose FlashAttention-2 with improved work partitioning.',
        citationCount: 1420,
        referenceCount: 48,
        influentialCitationCount: 310,
        openAccessPdf: {
          url: 'https://arxiv.org/pdf/2307.08691.pdf',
        },
        externalIds: {
          DOI: '10.48550/arXiv.2307.08691',
          ArXiv: '2307.08691',
          PubMed: '37999999',
          PubMedCentral: 'PMC10555555',
        },
        authors: [{ name: 'Tri Dao' }, { name: 'De La Cruz, Maria' }],
      });

      const provider = new SemanticScholarProvider();
      const res = await provider.resolve({
        query: '10.48550/arXiv.2307.08691',
        queryType: 'DOI',
      });

      expect(res).not.toBeNull();
      const meta = res!.metadata;
      expect(meta.itemType).toBe('conferencePaper');
      expect(meta.date).toBe('2023-07-17');
      expect(meta.year).toBe(2023);
      expect(meta.proceedingsTitle).toBe('ICLR Proceedings');
      expect(meta.conferenceName).toBe(
        'International Conference on Learning Representations',
      );
      expect(meta.volume).toBe('12');
      expect(meta.pages).toBe('1-16');
      expect(meta.issn).toBe('2640-3498');
      expect(meta.pmid).toBe('37999999');
      expect(meta.pmcid).toBe('PMC10555555');
      expect(meta.arxivId).toBe('2307.08691');
      expect(meta.archive).toBe('arXiv');
      expect(meta.archiveId).toBe('arXiv:2307.08691');
      expect(meta.citationCount).toBe(1420);
      expect(meta.referenceCount).toBe(48);
      expect(meta.openAccessPdfUrl).toBe(
        'https://arxiv.org/pdf/2307.08691.pdf',
      );
      expect(meta.libraryCatalog).toBe('Semantic Scholar');
      expect(meta.creators).toHaveLength(2);
      expect(meta.creators![0]).toMatchObject({
        firstName: 'Tri',
        lastName: 'Dao',
      });
      expect(meta.creators![1]).toMatchObject({
        firstName: 'Maria',
        lastName: 'De La Cruz',
      });
    });
  });

  describe('3. OpenLibraryProvider Fidelity (Subtitle, Structured Creators, Place, Edition, Subjects, NumPages)', () => {
    it('combines title + subtitle, sets shortTitle, parses structured creators, and extracts place, edition, subjects, and numPages', async () => {
      const isbn = '9780262033848';
      mockJsonResponse({
        [`ISBN:${isbn}`]: {
          title: 'Introduction to Algorithms',
          subtitle: 'A Comprehensive Guide',
          authors: [
            { name: 'Thomas H. Cormen' },
            { name: 'Charles E. Leiserson' },
          ],
          publishers: [{ name: 'MIT Press' }],
          publish_places: [{ name: 'Cambridge, MA' }],
          publish_date: 'July 31, 2009',
          edition_name: '3rd edition',
          number_of_pages: 1312,
          subjects: [
            { name: 'Computer algorithms' },
            { name: 'Data structures (Computer science)' },
          ],
          notes: 'Includes bibliographical references and index.',
          url: 'https://openlibrary.org/books/OL23257841M',
        },
      });

      const provider = new OpenLibraryProvider();
      const res = await provider.resolve({
        query: isbn,
        queryType: 'ISBN',
      });

      expect(res).not.toBeNull();
      const meta = res!.metadata;
      expect(meta.title).toBe(
        'Introduction to Algorithms: A Comprehensive Guide',
      );
      expect(meta.shortTitle).toBe('Introduction to Algorithms');
      expect(meta.publisher).toBe('MIT Press');
      expect(meta.place).toBe('Cambridge, MA');
      expect(meta.edition).toBe('3rd edition');
      expect(meta.numberOfPages).toBe(1312);
      expect(meta.numPages).toBe('1312');
      expect(meta.pages).toBe('1312');
      expect(meta.libraryCatalog).toBe('Open Library');
      expect(meta.keywords).toEqual(['Computer Algorithms', 'Data Structures']);
      expect(meta.tags).toEqual(['Computer Algorithms', 'Data Structures']);
      expect(meta.creators).toHaveLength(2);
      expect(meta.creators![0]).toMatchObject({
        firstName: 'Thomas H.',
        lastName: 'Cormen',
        creatorType: 'author',
      });
    });
  });

  describe('4. UrlMetadataScraperService Fidelity (Highwire/DublinCore/JSON-LD/COinS)', () => {
    it('extracts dissertation, conference, PMCID, journalAbbr, series, edition, rights, and JSON-LD Organization creators with fieldMode: 1', () => {
      const scraper = new UrlMetadataScraperService();
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta name="citation_title" content="Scalable Distributed Consensus: Protocols and Proofs" />
            <meta name="citation_dissertation_institution" content="ETH Zurich" />
            <meta name="citation_thesis_type" content="PhD Dissertation" />
            <meta name="citation_journal_abbrev" content="J. Distrib. Syst." />
            <meta name="citation_pmcid" content="PMC9988776" />
            <meta name="citation_publisher" content="ETH Press" />
            <meta name="citation_place" content="Zurich, Switzerland" />
            <meta name="citation_series_title" content="ETH Series in Computer Science" />
            <meta name="citation_edition" content="2nd" />
            <meta name="dc.rights" content="CC-BY-4.0" />
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "ScholarlyArticle",
                "author": [
                  { "@type": "Person", "givenName": "Jean", "familyName": "La Fontaine" },
                  { "@type": "Organization", "name": "Distributed Systems Consortium" }
                ]
              }
            </script>
          </head>
          <body></body>
        </html>
      `;

      const meta = scraper.extractHtmlMetadata(
        html,
        'https://ethz.ch/diss/12345',
      );
      expect(meta.title).toBe(
        'Scalable Distributed Consensus: Protocols and Proofs',
      );
      expect(meta.shortTitle).toBe('Scalable Distributed Consensus');
      expect(meta.itemType).toBe('thesis');
      expect(meta.university).toBe('ETH Zurich');
      expect(meta.thesisType).toBe('PhD Dissertation');
      expect(meta.journalAbbr).toBe('J. Distrib. Syst.');
      expect(meta.pmcid).toBe('PMC9988776');
      expect(meta.place).toBe('Zurich, Switzerland');
      expect(meta.series).toBe('ETH Series in Computer Science');
      expect(meta.edition).toBe('2nd');
      expect(meta.rights).toBe('CC-BY-4.0');
      expect(meta.creators).toBeDefined();
      expect(
        meta.creators!.some(
          (c) =>
            c.lastName === 'Distributed Systems Consortium' &&
            c.fieldMode === 1,
        ),
      ).toBe(true);
    });
  });

  describe('5. NormalizationPolicy & ReconciliationService Fidelity', () => {
    it('normalizes all Zotero Schema v42 type-specific fields and sets top-level numPages and numberOfPages', () => {
      const policy = new NormalizationPolicy();
      const normalized = policy.normalize({
        title: '   Deep Learning for Robotics   ',
        itemType: 'conferencePaper',
        proceedingsTitle: '  IEEE ICRA 2024  ',
        conferenceName:
          '  International Conference on Robotics and Automation  ',
        eventPlace: '  Yokohama, Japan  ',
        university: '  Stanford University  ',
        institution: '  SRI International  ',
        thesisType: '  PhD Thesis  ',
        reportNumber: '  TR-2024-09  ',
        reportType: '  Technical Report  ',
        programmingLanguage: '  Rust  ',
        versionNumber: '  1.4.0  ',
        system: '  Linux  ',
        rights: '  MIT License  ',
        libraryCatalog: '  IEEE Xplore  ',
        callNumber: '  QA76.73.R87 D44 2024  ',
        archive: '  arXiv  ',
        numberOfPages: '340',
      });

      expect(normalized.proceedingsTitle).toBe('IEEE ICRA 2024');
      expect(normalized.conferenceName).toBe(
        'International Conference on Robotics and Automation',
      );
      expect(normalized.eventPlace).toBe('Yokohama, Japan');
      expect(normalized.university).toBe('Stanford University');
      expect(normalized.institution).toBe('SRI International');
      expect(normalized.thesisType).toBe('PhD Thesis');
      expect(normalized.reportNumber).toBe('TR-2024-09');
      expect(normalized.reportType).toBe('Technical Report');
      expect(normalized.programmingLanguage).toBe('Rust');
      expect(normalized.versionNumber).toBe('1.4.0');
      expect(normalized.system).toBe('Linux');
      expect(normalized.rights).toBe('MIT License');
      expect(normalized.libraryCatalog).toBe('IEEE Xplore');
      expect(normalized.callNumber).toBe('QA76.73.R87 D44 2024');
      expect(normalized.archive).toBe('arXiv');
      expect(normalized.numberOfPages).toBe(340);
      expect(normalized.numPages).toBe('340');
    });

    it('reconciles SemanticScholar candidates with proper weights and harmonizes creators/authors and Zotero baseField venue/publisher', () => {
      const service = new ReconciliationService();
      const candidates: MetadataCandidate[] = [
        {
          sourceProvider: 'SemanticScholar',
          confidenceScore: 0.92,
          retrievedAt: new Date().toISOString(),
          metadata: {
            title: 'Neural Scaling Laws in Practice',
            authors: ['Jared Kaplan', 'Sam McCandlish'],
            year: 2024,
            itemType: 'conferencePaper',
            publicationTitle:
              'Advances in Neural Information Processing Systems',
            publisher: 'Curran Associates',
            citationCount: 512,
            referenceCount: 64,
          },
        },
      ];

      const result = service.reconcile(candidates);
      expect(result.metadata.title).toBe('Neural Scaling Laws in Practice');
      expect(result.metadata.proceedingsTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(result.metadata.creators).toHaveLength(2);
      expect(result.metadata.creators![0]).toMatchObject({
        firstName: 'Jared',
        lastName: 'Kaplan',
        creatorType: 'author',
      });
      expect(result.metadata.citationCount).toBe(512);
    });
  });

  describe('6. ItemTransformer.previewConversion Universal Bibliographic Field Preservation', () => {
    it('preserves accessedAt, libraryCatalog, archive, archiveLocation, callNumber, rights, language, and shortTitle when converting item types', () => {
      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);

      const sourceItem = {
        id: 'item-1',
        itemType: 'journalArticle',
        title: 'Foundations of Statistical Natural Language Processing',
        shortTitle: 'Foundations of Statistical NLP',
        publicationTitle: 'Computational Linguistics',
        language: 'en-US',
        rights: 'Copyright 1999 MIT Press',
        libraryCatalog: 'MIT Press Catalog',
        archive: 'Internet Archive',
        archiveLocation: 'ark:/13960/t12345',
        callNumber: 'QA76.9.N38 M36 1999',
        accessedAt: new Date('2025-02-15T00:00:00.000Z'),
        doi: '10.1162/coli.1999.25.4.631',
        creators: [],
      };

      const preview = transformer.previewConversion(sourceItem, 'report');
      expect(preview.droppedFields.map((d) => d.field)).not.toContain(
        'libraryCatalog',
      );
      expect(preview.droppedFields.map((d) => d.field)).not.toContain(
        'callNumber',
      );
      expect(preview.droppedFields.map((d) => d.field)).not.toContain('rights');
      expect(preview.droppedFields.map((d) => d.field)).not.toContain(
        'language',
      );
      expect(preview.droppedFields.map((d) => d.field)).not.toContain(
        'shortTitle',
      );
      expect(preview.projectedItem.libraryCatalog).toBe('MIT Press Catalog');
      expect(preview.projectedItem.callNumber).toBe('QA76.9.N38 M36 1999');
      expect(preview.projectedItem.rights).toBe('Copyright 1999 MIT Press');
      expect(preview.projectedItem.language).toBe('en-US');
      expect(preview.projectedItem.shortTitle).toBe(
        'Foundations of Statistical NLP',
      );
    });
  });

  describe('7. Author Particle & LaTeX Diacritic Edge Cases', () => {
    it('correctly parses capitalized and compound surname particles in natural order and Vancouver format', () => {
      const c1 = parseCreatorString('Jean La Fontaine', 0, 'author');
      expect(c1).toMatchObject({
        firstName: 'Jean',
        lastName: 'La Fontaine',
      });

      const c2 = parseCreatorString('Ursula Le Guin', 1, 'author');
      expect(c2).toMatchObject({
        firstName: 'Ursula',
        lastName: 'Le Guin',
      });

      const c3 = parseCreatorString('Bartolomé de Las Casas', 2, 'author');
      expect(c3).toMatchObject({
        firstName: 'Bartolomé',
        lastName: 'de Las Casas',
      });

      const c4 = parseCreatorString('Muhammad Al Khwarizmi', 3, 'author');
      expect(c4).toMatchObject({
        firstName: 'Muhammad',
        lastName: 'Al Khwarizmi',
      });

      const c5 = parseCreatorString(
        'Cornelius Vanderbilt St. Clair',
        4,
        'author',
      );
      expect(c5).toMatchObject({
        firstName: 'Cornelius Vanderbilt',
        lastName: 'St. Clair',
      });
    });

    it('decodes dotless \\i and \\j inside LaTeX accents as well as \\dj, \\DJ, \\ng, \\NG, \\th, \\TH, \\dh, \\DH', () => {
      expect(stripLatexBraces('S{\\\'\\i}nclair and N{\\"\\i}ls')).toBe(
        'Sínclair and Nïls',
      );
      expect(stripLatexBraces("{\\v\\i} and {\\'{\\i}} and {\\^\\j}")).toBe(
        'ǐ and í and ĵ',
      );
      expect(
        stripLatexBraces("{\\DJ}or{\\dj}evi{\\'c} and {\\th}orn and {\\dh}"),
      ).toBe('Đorđević and þorn and ð');
      expect(stripLatexBraces('{\\ng} and {\\NG}')).toBe('ŋ and Ŋ');
    });
  });

  describe('8. Schema-Driven Field Preservation & Unblocked Cross-Type Duplicate Merging', () => {
    it('normalizes and preserves all Zotero Schema v42 string fields dynamically in NormalizationPolicy', () => {
      const policy = new NormalizationPolicy();
      const normalized = policy.normalize({
        title: '   Legal Statute on AI Governance  ',
        itemType: 'statute',
        nameOfAct: '  Artificial Intelligence Act  ',
        publicLawNumber: '  EU-2024/1689  ',
        programTitle: '  Tech Law Podcast  ',
        network: '  European Broadcasting Union  ',
        scale: '  1:50,000  ',
      });

      expect(normalized.nameOfAct).toBe('Artificial Intelligence Act');
      expect(normalized.publicLawNumber).toBe('EU-2024/1689');
      expect(normalized.programTitle).toBe('Tech Law Podcast');
      expect(normalized.network).toBe('European Broadcasting Union');
      expect(normalized.scale).toBe('1:50,000');
    });

    it('merges cross-type duplicate items (e.g. webpage + journalArticle) and custom metadata fields without arbitrary 400 rejection', async () => {
      const updatedItems: Record<string, unknown>[] = [];
      const mockTx = {
        itemRelation: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        item: {
          update: jest.fn().mockImplementation(async ({ data }) => {
            updatedItems.push(data);
            return { id: 'primary-1', version: 2, ...data };
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockImplementation(async () => ({
            id: 'primary-1',
            title: 'Attention Is All You Need',
            itemType: 'journalArticle',
            version: 2,
            ...(updatedItems[0] || {}),
          })),
        },
      } as unknown as Prisma.TransactionClient;

      const mockTxService = {
        executeInTransaction: jest.fn().mockImplementation(async (fn) =>
          fn(mockTx, {
            appendChange: jest.fn(),
            publishOutbox: jest.fn(),
            recordTombstone: jest.fn(),
          }),
        ),
      } as unknown as TransactionService;

      const mockCatalogGateway = {
        findByIds: jest.fn().mockResolvedValue([
          {
            id: 'primary-1',
            title: 'Attention Is All You Need',
            itemType: 'journalArticle',
            doi: '10.48550/arXiv.1706.03762',
            metadata: {},
          },
          {
            id: 'dup-webpage-1',
            title: 'Attention Is All You Need (Web Capture)',
            itemType: 'webpage',
            url: 'https://arxiv.org/abs/1706.03762',
            metadata: {
              arxivId: '1706.03762v7',
              websiteTitle: 'arXiv.org',
            },
          },
        ]),
        mergeItems: jest.fn().mockResolvedValue(undefined),
      } as unknown as ICatalogGatewayPort;

      const duplicateService = new DuplicateService(
        mockTxService,
        mockCatalogGateway,
      );

      const res = await duplicateService.mergeDuplicates('user-1', {
        primaryItemId: 'primary-1',
        duplicateItemIds: ['dup-webpage-1'],
        fieldSelections: {
          customCuratedField: 'curated-value-123',
        },
      });

      expect(res.primaryItem.id).toBe('primary-1');
      expect(updatedItems).toHaveLength(2);
      expect(updatedItems[0].itemType).toBe('journalArticle');
      expect(
        (updatedItems[0].metadata as Record<string, unknown>).arxivId,
      ).toBe('1706.03762v7');
      expect(
        (updatedItems[0].metadata as Record<string, unknown>)
          .customCuratedField,
      ).toBe('curated-value-123');
    });

    it('preserves all Zotero v42 scraped fields (arxivId, pmid, shortTitle, websiteTitle, versionNumber, etc.) in UrlCaptureService.confirmCapturedUrl', async () => {
      let createdPayload: Record<string, unknown> | undefined;
      const mockRepo = {
        findCapturePreviewByTokenHash: jest.fn().mockResolvedValue({
          id: 'preview-1',
          sourceUrl: 'https://arxiv.org/abs/2305.12345v2',
          canonicalMetadata: {
            title: 'QLoRA: Efficient Finetuning of Quantized LLMs',
            itemType: 'preprint',
            arxivId: '2305.12345v2',
            pmid: '38001122',
            shortTitle: 'QLoRA',
            repository: 'arXiv',
            versionNumber: 'v2',
            extraFields: {
              primaryCategory: 'cs.CL',
            },
          },
        }),
        claimCapturePreview: jest.fn().mockResolvedValue(1),
      } as unknown as IngestionRepository;

      const mockCatalogGateway = {
        createItem: jest.fn().mockImplementation(async (_u, data) => {
          createdPayload = data as Record<string, unknown>;
          return { id: 'item-created-1', ...data };
        }),
      } as unknown as ICatalogGatewayPort;

      const urlCaptureService = new UrlCaptureService(
        mockRepo,
        undefined,
        undefined,
        mockCatalogGateway,
      );

      await urlCaptureService.confirmCapturedUrl('user-1', 'user-1', {
        previewToken: 'raw-token',
      });

      expect(createdPayload).toBeDefined();
      expect(createdPayload?.arxivId).toBe('2305.12345v2');
      expect(createdPayload?.pmid).toBe('38001122');
      expect(createdPayload?.shortTitle).toBe('QLoRA');
      expect(createdPayload?.repository).toBe('arXiv');
      expect(createdPayload?.versionNumber).toBe('v2');
      expect(createdPayload?.primaryCategory).toBe('cs.CL');
    });

    it('maps Zotero v42 fields via SCHEMA_V42_DATA.cslFieldMap in CslJsonMapper.toCsl', () => {
      const csl = CslJsonMapper.toCsl({
        id: 'item-csl-1',
        itemType: 'journalArticle',
        title: 'Test Paper: A Subtitle',
        shortTitle: 'Test Paper',
        extraFields: {
          language: 'en-US',
          journalAbbreviation: 'J. Test. Res.',
          rights: 'CC-BY-4.0',
        },
      });

      expect(csl['title-short']).toBe('Test Paper');
      expect((csl as Record<string, unknown>).shortTitle).toBe('Test Paper');
      expect(csl.language).toBe('en-US');
      expect(csl.journalAbbreviation).toBe('J. Test. Res.');
    });
  });
});
