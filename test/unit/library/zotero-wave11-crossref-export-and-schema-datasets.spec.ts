import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { UrlCaptureProvider } from '@/modules/library/ingestion/providers/url-capture.provider';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { ExtractionHandler } from '@/modules/library/extraction/services/extraction.handler';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { ExportsService } from '@/modules/library/citation/services/exports.service';

describe('Zotero Wave 11/12: CrossRef, ArXiv, URL Capture, PDF Extraction & Multi-Dataset Export Fidelity', () => {
  describe('1. CrossRefProvider Multi-Dataset & Rich Field Fidelity', () => {
    let provider: CrossRefProvider;

    beforeEach(() => {
      provider = new CrossRefProvider();
    });

    it('extracts subtitle into title and defaults shortTitle to baseTitle when short-title is absent', () => {
      const transform = (
        provider as unknown as {
          transformMessage: (
            msg: Record<string, unknown>,
            doi: string,
            isDirect: boolean,
          ) => { metadata: Record<string, unknown> };
        }
      ).transformMessage.bind(provider);

      const res = transform(
        {
          type: 'book',
          title: ['Designing Data-Intensive Applications'],
          subtitle: [
            'The Big Ideas Behind Reliable, Scalable, and Maintainable Systems',
          ],
          author: [{ given: 'Martin', family: 'Kleppmann' }],
          publisher: "O'Reilly Media",
          'publisher-location': 'Sebastopol, CA',
          'edition-number': '2',
          ISBN: ['978-1-4493-7332-0'],
          issued: { 'date-parts': [[2017, 3, 16]] },
        },
        '10.1000/ddia.2017',
        true,
      );

      expect(res.metadata.itemType).toBe('book');
      expect(res.metadata.title).toBe(
        'Designing Data-Intensive Applications: The Big Ideas Behind Reliable, Scalable, and Maintainable Systems',
      );
      expect(res.metadata.shortTitle).toBe(
        'Designing Data-Intensive Applications',
      );
      expect(res.metadata.edition).toBe('2');
      expect(res.metadata.place).toBe('Sebastopol, CA');
      expect(res.metadata.isbn).toBe('9781449373320');
    });

    it('falls back to article-number when page is absent for e-first/article-numbered journals', () => {
      const transform = (
        provider as unknown as {
          transformMessage: (
            msg: Record<string, unknown>,
            doi: string,
            isDirect: boolean,
          ) => { metadata: Record<string, unknown> };
        }
      ).transformMessage.bind(provider);

      const res = transform(
        {
          type: 'journal-article',
          title: [
            'Quantum supremacy using a programmable superconducting processor',
          ],
          'container-title': ['Nature Communications'],
          volume: '14',
          issue: '1',
          'article-number': 'e202304512',
          issued: { 'date-parts': [[2023, 8, 12]] },
        },
        '10.1038/s41467-023-04512-x',
        true,
      );

      expect(res.metadata.itemType).toBe('journalArticle');
      expect(res.metadata.pages).toBe('e202304512');
      expect(res.metadata.volume).toBe('14');
      expect(res.metadata.issue).toBe('1');
    });

    it('maps dissertation institution, degree, and place to thesis university, thesisType, and place', () => {
      const transform = (
        provider as unknown as {
          transformMessage: (
            msg: Record<string, unknown>,
            doi: string,
            isDirect: boolean,
          ) => { metadata: Record<string, unknown> };
        }
      ).transformMessage.bind(provider);

      const res = transform(
        {
          type: 'dissertation',
          title: [
            'Architectural Styles and the Design of Network-based Software Architectures',
          ],
          author: [{ given: 'Roy Thomas', family: 'Fielding' }],
          institution: [
            {
              name: 'University of California, Irvine',
              place: ['Irvine, CA'],
            },
          ],
          degree: ['Ph.D.'],
          issued: { 'date-parts': [[2000]] },
        },
        '10.5555/932295',
        true,
      );

      expect(res.metadata.itemType).toBe('thesis');
      expect(res.metadata.university).toBe('University of California, Irvine');
      expect(res.metadata.publisher).toBe('University of California, Irvine');
      expect(res.metadata.place).toBe('Irvine, CA');
      expect(res.metadata.thesisType).toBe('Ph.D.');
    });

    it('maps report institution, subtype, and report-number to report fields', () => {
      const transform = (
        provider as unknown as {
          transformMessage: (
            msg: Record<string, unknown>,
            doi: string,
            isDirect: boolean,
          ) => { metadata: Record<string, unknown> };
        }
      ).transformMessage.bind(provider);

      const res = transform(
        {
          type: 'report',
          title: ['Zero Trust Architecture'],
          author: [{ name: 'National Institute of Standards and Technology' }],
          institution: {
            name: 'National Institute of Standards and Technology',
            place: 'Gaithersburg, MD',
          },
          subtype: 'Special Publication',
          'report-number': 'NIST SP 800-207',
          issued: { 'date-parts': [[2020, 8]] },
        },
        '10.6028/NIST.SP.800-207',
        true,
      );

      expect(res.metadata.itemType).toBe('report');
      expect(res.metadata.institution).toBe(
        'National Institute of Standards and Technology',
      );
      expect(res.metadata.reportType).toBe('Special Publication');
      expect(res.metadata.reportNumber).toBe('NIST SP 800-207');
      expect(res.metadata.place).toBe('Gaithersburg, MD');
      expect(res.metadata.creators).toEqual([
        expect.objectContaining({
          creatorType: 'author',
          lastName: 'National Institute of Standards and Technology',
          fullName: 'National Institute of Standards and Technology',
          fieldMode: 1,
        }),
      ]);
    });
  });

  describe('2. ArxivProvider & UrlCaptureProvider Structured Creator & Field Fidelity', () => {
    it('ArxivProvider parses structured creators with firstName/lastName/fieldMode and extracts versionNumber', async () => {
      const provider = new ArxivProvider();
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
          <entry>
            <id>http://arxiv.org/abs/1706.03762v7</id>
            <published>2017-06-12T17:57:34Z</published>
            <title>Attention Is All You Need</title>
            <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary>
            <author><name>Ashish Vaswani</name></author>
            <author><name>Noam Shazeer</name></author>
            <arxiv:primary_category term="cs.CL"/>
            <category term="cs.CL"/>
            <category term="cs.LG"/>
            <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
          </entry>
        </feed>`;

      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => xml,
      } as Response);

      try {
        const res = await provider.resolve({
          query: '1706.03762v7',
          queryType: 'ARXIV',
        });

        expect(res).not.toBeNull();
        expect(res?.metadata.arxivId).toBe('1706.03762v7');
        expect(res?.metadata.versionNumber).toBe('v7');
        expect(res?.metadata.creators).toEqual([
          expect.objectContaining({
            orderIndex: 0,
            creatorType: 'author',
            firstName: 'Ashish',
            lastName: 'Vaswani',
            fullName: 'Ashish Vaswani',
            fieldMode: 0,
          }),
          expect.objectContaining({
            orderIndex: 1,
            creatorType: 'author',
            firstName: 'Noam',
            lastName: 'Shazeer',
            fullName: 'Noam Shazeer',
            fieldMode: 0,
          }),
        ]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('UrlCaptureProvider preserves fieldMode, parses string authors via parseCreatorString, and passes through rich Zotero v42 fields', () => {
      const provider = new UrlCaptureProvider();
      const mapScraped = (
        provider as unknown as {
          mapScrapedResult: (
            scraped: Record<string, unknown>,
            url: string,
          ) => Record<string, unknown>;
        }
      ).mapScrapedResult.bind(provider);

      const captured = mapScraped(
        {
          url: 'https://dl.acm.org/doi/10.1145/3292500.3330701',
          isPdf: false,
          confidence: 0.95,
          itemType: 'conferencePaper',
          title:
            'LightGCN: Simplifying and Powering Graph Convolution Network for Recommendation',
          shortTitle: 'LightGCN',
          creators: [
            {
              firstName: 'Xiangnan',
              lastName: 'He',
              fullName: 'Xiangnan He',
              creatorType: 'author',
              fieldMode: 0,
            },
            {
              lastName: 'ACM SIGIR Committee',
              fullName: 'ACM SIGIR Committee',
              creatorType: 'editor',
              fieldMode: 1,
            },
          ],
          doi: '10.1145/3292500.3330701',
          pmcid: 'PMC7654321',
          conferenceName: 'SIGIR 2020',
          proceedingsTitle:
            'Proceedings of the 43rd International ACM SIGIR Conference',
          series: 'SIGIR Series',
          place: 'Virtual Event, China',
          edition: '1st',
          language: 'en',
          rights: 'CC BY 4.0',
        },
        'https://dl.acm.org/doi/10.1145/3292500.3330701',
      );

      expect(captured.itemType).toBe('conferencePaper');
      expect(captured.shortTitle).toBe('LightGCN');
      expect(captured.pmcid).toBe('PMC7654321');
      expect(captured.conferenceName).toBe('SIGIR 2020');
      expect(captured.proceedingsTitle).toBe(
        'Proceedings of the 43rd International ACM SIGIR Conference',
      );
      expect(captured.publicationTitle).toBe(
        'Proceedings of the 43rd International ACM SIGIR Conference',
      );
      expect(captured.place).toBe('Virtual Event, China');
      expect(captured.series).toBe('SIGIR Series');
      expect(captured.edition).toBe('1st');
      expect(captured.language).toBe('en');
      expect(captured.rights).toBe('CC BY 4.0');
      expect(captured.creators).toEqual([
        expect.objectContaining({
          firstName: 'Xiangnan',
          lastName: 'He',
          creatorType: 'author',
          fieldMode: 0,
        }),
        expect.objectContaining({
          lastName: 'ACM SIGIR Committee',
          creatorType: 'editor',
          fieldMode: 1,
        }),
      ]);
    });
  });

  describe('3. PDF Extraction Heuristics & Handler Backfill Fidelity', () => {
    it('extracts legacy arXiv IDs (e.g. hep-th/9905111v1), ISSN, and PMID from PDF text and headers', () => {
      const pdfProvider = new PdfProvider();

      const headerBuf = Buffer.from(
        '%PDF-1.5\n/Title (Large N Field Theories, String Theory and Gravity)\n/Author (Juan M. Maldacena)\narXiv:hep-th/9905111v3 [hep-th]\n',
        'latin1',
      );
      const headerMeta = pdfProvider.extractMetadataFromBuffer(headerBuf);
      expect(headerMeta.arxivId).toBe('hep-th/9905111v3');
      expect(headerMeta.primaryCategory).toBe('hep-th');

      const textSample = `
        arXiv:cs.AI/0112017v1 [cs.AI] 10 Dec 2001
        ISSN: 1532-4435
        PMID: 34567890
        ISBN-13: 978-0-262-03561-3
        MIT Press
        Abstract: We present a unified framework for probabilistic graphical models.
      `;
      const textMeta = pdfProvider.extractMetadataFromText(textSample);
      expect(textMeta.arxivId).toBe('cs.AI/0112017v1');
      expect(textMeta.issn).toBe('1532-4435');
      expect(textMeta.pmid).toBe('34567890');
      expect(textMeta.isbn).toBe('9780262035613');
      expect(textMeta.publisher).toBe('MIT Press');
    });

    it('non-destructively backfills extracted bibliographic fields in ExtractionHandler without overwriting existing metadata', async () => {
      const updateItemMock = jest.fn().mockResolvedValue(undefined);
      const mockRepo = {
        claimPendingOrRetryable: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueAttachment: jest.fn().mockResolvedValue({
          id: 'att-1',
          itemId: 'item-1',
          userId: 'user-1',
          fileId: 'file-1',
          extractionStatus: 'PROCESSING',
          item: {
            id: 'item-1',
            userId: 'user-1',
            title: 'Untitled Document',
            doi: null,
            abstract: null,
            year: null,
            publicationTitle: null,
            metadata: {
              publisher: 'Existing Publisher Should Stay',
            },
          },
        }),
        persistExtractedPagesAndComplete: jest
          .fn()
          .mockResolvedValue(undefined),
        completeExtraction: jest.fn().mockResolvedValue(undefined),
        markReady: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
        saveMetadataSourceRecord: jest.fn().mockResolvedValue(undefined),
        updateItem: updateItemMock,
        countContributors: jest.fn().mockResolvedValue(1),
        countItemTags: jest.fn().mockResolvedValue(1),
      };
      const mockPdfProvider = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          metadata: {
            title: 'Extracted Deep Learning Book',
            doi: '10.1000/dl.2024',
            year: 2024,
            isbn: '9780262035613',
            issn: '1532-4435',
            pmid: '34567890',
            arxivId: '2401.12345v1',
            publisher: 'New Publisher Should Not Overwrite',
            place: 'Cambridge, MA',
            bookTitle: 'Adaptive Computation and Machine Learning',
            volume: '3',
            issue: '2',
            pages: '100-150',
            numberOfPages: 51,
          },
          pages: [
            { pageIndex: 1, textContent: 'Page 1 content', charOffset: 0 },
          ],
          references: [{ rawText: '[1] Ref 1' }],
        }),
      };
      const mockStorage = {
        readOwnedFile: jest
          .fn()
          .mockResolvedValue({ buffer: Buffer.from('%PDF-1.5 dummy') }),
      };

      const handler = new ExtractionHandler(
        mockRepo as never,
        mockPdfProvider as never,
        mockStorage as never,
      );

      await handler.handle({
        id: 'evt-1',
        aggregateId: 'att-1',
        payload: {
          attachmentId: 'att-1',
        },
      } as never);

      expect(updateItemMock).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          title: 'Extracted Deep Learning Book',
          doi: '10.1000/dl.2024',
          year: 2024,
          publicationTitle: 'Adaptive Computation and Machine Learning',
          metadata: expect.objectContaining({
            publisher: 'Existing Publisher Should Stay',
            isbn: '9780262035613',
            issn: '1532-4435',
            pmid: '34567890',
            arxivId: '2401.12345v1',
            place: 'Cambridge, MA',
            bookTitle: 'Adaptive Computation and Machine Learning',
            volume: '3',
            issue: '2',
            pages: '100-150',
            numberOfPages: 51,
            referenceCount: 1,
          }),
        }),
      );
    });
  });

  describe('4. Citation & Export Fidelity for Non-Article Datasets (BibTeX, RIS, CSL-JSON)', () => {
    let cslEngine: CslEngineService;
    let citationService: CitationService;
    let exportsService: ExportsService;

    beforeEach(() => {
      cslEngine = new CslEngineService();
      cslEngine.onModuleInit();
      citationService = new CitationService(undefined, cslEngine);
    });

    it('maps Legal Case (case) and Statute (statute) datasets accurately to CSL-JSON, BibTeX, and RIS', () => {
      const legalCaseCsl = CslJsonMapper.toCsl({
        id: 'brown1954',
        itemType: 'case',
        title: '',
        metadata: {
          caseName: 'Brown v. Board of Education',
          court: 'Supreme Court of the United States',
          docketNumber: 'No. 1',
          reporter: 'U.S.',
          reporterVolume: '347',
          firstPage: '483',
          dateDecided: '1954-05-17',
        },
      });

      expect(legalCaseCsl.type).toBe('legal_case');
      expect(legalCaseCsl.title).toBe('Brown v. Board of Education');
      expect(legalCaseCsl.authority).toBe('Supreme Court of the United States');
      expect(legalCaseCsl.number).toBe('No. 1');
      expect(legalCaseCsl['container-title']).toBe('U.S.');
      expect(legalCaseCsl.volume).toBe('347');
      expect(legalCaseCsl.page).toBe('483');
      expect(legalCaseCsl.issued).toEqual({
        'date-parts': [[1954, 5, 17]],
      });

      const caseRis = cslEngine.formatRis(legalCaseCsl);
      expect(caseRis).toContain('TY  - CASE');
      expect(caseRis).toContain('TI  - Brown v. Board of Education');

      const statuteCsl = CslJsonMapper.toCsl({
        id: 'ada1990',
        itemType: 'statute',
        title: '',
        metadata: {
          nameOfAct: 'Americans with Disabilities Act of 1990',
          publicLawNumber: 'Pub. L. No. 101-336',
          code: 'U.S.C.',
          codeNumber: '42',
          dateEnacted: '1990-07-26',
        },
      });

      expect(statuteCsl.type).toBe('legislation');
      expect(statuteCsl.title).toBe('Americans with Disabilities Act of 1990');
      expect(statuteCsl.number).toBe('Pub. L. No. 101-336');
      expect(statuteCsl['container-title']).toBe('U.S.C.');
      expect(statuteCsl.volume).toBe('42');
      expect(statuteCsl.issued).toEqual({
        'date-parts': [[1990, 7, 26]],
      });

      const statuteRis = cslEngine.formatRis(statuteCsl);
      expect(statuteRis).toContain('TY  - STAT');
      expect(statuteRis).toContain(
        'TI  - Americans with Disabilities Act of 1990',
      );
    });

    it('maps Patent, Standard, Software (computerProgram), and Dataset items to BibTeX and RIS without field loss', () => {
      // 1. Patent
      const patentCsl = CslJsonMapper.toCsl({
        id: 'pagerank1998',
        itemType: 'patent',
        title: 'Method for node ranking in a linked database',
        contributors: [
          {
            creatorType: 'inventor',
            firstName: 'Lawrence',
            lastName: 'Page',
            orderIndex: 0,
          },
        ],
        metadata: {
          patentNumber: 'US6285999B1',
          applicationNumber: 'US09/004,827',
          issuingAuthority: 'United States Patent and Trademark Office',
          country: 'US',
          filingDate: '1998-01-09',
          issueDate: '2001-09-04',
        },
      });

      expect(patentCsl.type).toBe('patent');
      expect(patentCsl.number).toBe('US6285999B1');
      expect(patentCsl['call-number']).toBe('US09/004,827');
      expect(patentCsl.authority).toBe(
        'United States Patent and Trademark Office',
      );
      expect(patentCsl.jurisdiction).toBe('US');
      expect(patentCsl.submitted).toEqual({ 'date-parts': [[1998, 1, 9]] });
      expect(patentCsl.issued).toEqual({ 'date-parts': [[2001, 9, 4]] });

      const patentBib = cslEngine.formatBibtex(patentCsl);
      expect(patentBib).toMatch(/^@patent\{pagerank1998,/);
      expect(patentBib).toContain('number = {US6285999B1}');

      const patentRis = cslEngine.formatRis(patentCsl);
      expect(patentRis).toContain('TY  - PAT');
      expect(patentRis).toContain('IS  - US6285999B1');

      // 2. Standard
      const standardCsl = CslJsonMapper.toCsl({
        id: 'iso27001',
        itemType: 'standard',
        title: 'Information security, cybersecurity and privacy protection',
        contributors: [
          {
            creatorType: 'author',
            fullName: 'International Organization for Standardization',
            fieldMode: 1,
          },
        ],
        metadata: {
          organization: 'ISO/IEC',
          number: 'ISO/IEC 27001:2022',
          publicationDate: '2022-10',
        },
      });

      const standardBib = cslEngine.formatBibtex(standardCsl);
      expect(standardBib).toMatch(/^@standard\{iso27001,/);
      expect(standardBib).toContain(
        'author = {{International Organization for Standardization}}',
      );
      expect(standardBib).toContain('institution = {ISO/IEC}');
      expect(standardBib).toContain('number = {ISO/IEC 27001:2022}');

      const standardRis = cslEngine.formatRis(standardCsl);
      expect(standardRis).toContain('TY  - STAND');

      // 3. Computer Program / Software
      const softwareCsl = CslJsonMapper.toCsl({
        id: 'pytorch2024',
        itemType: 'computerProgram',
        title:
          'PyTorch: An Imperative Style, High-Performance Deep Learning Library',
        url: 'https://pytorch.org',
        accessedAt: '2024-05-20',
        contributors: [
          {
            creatorType: 'programmer',
            firstName: 'Adam',
            lastName: 'Paszke',
            orderIndex: 0,
          },
        ],
        metadata: {
          versionNumber: '2.3.0',
          company: 'Linux Foundation',
          year: 2024,
        },
        year: 2024,
      });

      const softwareBib = cslEngine.formatBibtex(softwareCsl);
      expect(softwareBib).toMatch(/^@software\{pytorch2024,/);
      expect(softwareBib).toContain('version = {2.3.0}');
      expect(softwareBib).toContain('publisher = {Linux Foundation}');
      expect(softwareBib).toContain('urldate = {2024-05-20}');

      const softwareRis = cslEngine.formatRis(softwareCsl);
      expect(softwareRis).toContain('TY  - COMP');
      expect(softwareRis).toMatch(/Y2\s+-\s+2024[-/]0?5[-/]20/);
    });

    it('distinguishes Master thesis (@mastersthesis) from PhD thesis (@phdthesis) and preserves school/type', () => {
      const mastersCsl = CslJsonMapper.toCsl({
        id: 'nguyen2023ms',
        itemType: 'thesis',
        title: 'Deep Learning for Vietnamese NLP',
        year: 2023,
        metadata: {
          university: 'Hanoi University of Science and Technology',
          thesisType: "Master's Thesis",
          place: 'Hanoi, Vietnam',
        },
      });

      const mastersBib = cslEngine.formatBibtex(mastersCsl);
      expect(mastersBib).toMatch(/^@mastersthesis\{nguyen2023ms,/);
      expect(mastersBib).toMatch(
        /school\s*=\s*\{+Hanoi University of Science and Technology\}+/,
      );
      expect(mastersBib).toContain("type = {Master's Thesis}");
      expect(mastersBib).toContain('address = {Hanoi, Vietnam}');

      const phdCsl = CslJsonMapper.toCsl({
        id: 'fielding2000phd',
        itemType: 'thesis',
        title: 'REST Architectural Style',
        year: 2000,
        metadata: {
          university: 'UC Irvine',
          thesisType: 'PhD Dissertation',
        },
      });

      const phdBib = cslEngine.formatBibtex(phdCsl);
      expect(phdBib).toMatch(/^@phdthesis\{fielding2000phd,/);
      expect(phdBib).toMatch(/school\s*=\s*\{+UC Irvine\}+/);
    });

    it('ExportsService exports multi-dataset libraries to BibTeX and RIS with editors, series, keywords, and institutional braces', async () => {
      const mockExportsRepo = {
        findItems: jest.fn().mockResolvedValue([
          {
            id: 'item-chap-1',
            citationKey: 'bengio2016chap',
            itemType: 'bookSection',
            title: 'Sequence Modeling: Recurrent and Recursive Nets',
            publicationTitle: 'Deep Learning',
            year: 2016,
            doi: '10.5555/3086952.3086962',
            url: 'https://www.deeplearningbook.org',
            abstract: 'Chapter 10 on RNNs and LSTMs.',
            contributors: [
              {
                creatorType: 'author',
                firstName: 'Yoshua',
                lastName: 'Bengio',
                fullName: 'Yoshua Bengio',
                orderIndex: 0,
              },
              {
                creatorType: 'editor',
                firstName: 'Ian',
                lastName: 'Goodfellow',
                fullName: 'Ian Goodfellow',
                orderIndex: 1,
              },
            ],
            itemTags: [{ tag: { name: 'recurrent-networks' } }],
            metadata: {
              bookTitle: 'Deep Learning',
              publisher: 'MIT Press',
              place: 'Cambridge, MA',
              series: 'Adaptive Computation and Machine Learning',
              edition: '1',
              pages: '367-415',
              isbn: '978-0-262-03561-3',
              keywords: ['deep-learning'],
            },
          },
        ]),
      };

      exportsService = new ExportsService(
        mockExportsRepo as never,
        citationService,
        {} as never,
      );

      const bibExport = await exportsService.exportLibrary('user-1', {
        format: 'bibtex',
        itemIds: ['item-chap-1'],
      });

      expect(bibExport.content).toMatch(/^@incollection\{bengio2016chap,/);
      expect(bibExport.content).toMatch(
        /booktitle\s*=\s*\{Deep \{?Learning\}?\}/,
      );
      expect(bibExport.content).toContain('editor = {Goodfellow, Ian}');
      expect(bibExport.content).toMatch(
        /series\s*=\s*\{Adaptive \{?Computation\}? and \{?Machine\}? \{?Learning\}?\}/,
      );
      expect(bibExport.content).toContain('edition = {1}');
      expect(bibExport.content).toContain('address = {Cambridge, MA}');
      expect(bibExport.content).toContain('pages = {367--415}');
      expect(bibExport.content).toContain('isbn = {978-0-262-03561-3}');

      const risExport = await exportsService.exportLibrary('user-1', {
        format: 'ris',
        itemIds: ['item-chap-1'],
      });

      expect(risExport.content).toContain('TY  - CHAP');
      expect(risExport.content).toContain('ED  - Goodfellow, Ian');
      expect(risExport.content).toContain(
        'T3  - Adaptive Computation and Machine Learning',
      );
      expect(risExport.content).toContain('ET  - 1');
      expect(risExport.content).toContain('CY  - Cambridge, MA');
      expect(risExport.content).toContain('SP  - 367');
      expect(risExport.content).toContain('EP  - 415');
      expect(risExport.content).toContain('KW  - deep-learning');
      expect(risExport.content).toContain('KW  - recurrent-networks');
    });
  });
});
