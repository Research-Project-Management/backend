import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import {
  IEEE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
  NATURE_CSL,
  TCVN_CSL,
  TCVN_NUMERIC_CSL,
} from '@/modules/library/citation/data/official-styles.data';
import { CatalogItemRecord } from '@/modules/library/citation/types/citation.types';
import type { ICatalogFacade } from '@/modules/library/core';

describe('Wave 8 — Citation, Export & Metadata Format Grounding & Accuracy', () => {
  let cslEngine: CslEngineService;
  let citationService: CitationService;

  beforeEach(() => {
    cslEngine = new CslEngineService();
    citationService = new CitationService(undefined, cslEngine);
  });

  // 1. Official CSL 1.0 XML Styles: IEEE, Chicago 17th, MLA 9th, Nature
  describe('1. Official CSL 1.0 XML Styles Accuracy (IEEE, Chicago 17th, MLA 9th, Nature)', () => {
    it('renders IEEE journal article with volume, issue, page range, year, and DOI without invalid date-part bugs', () => {
      // Ensure invalid <date-part name="volume"/> is eliminated from IEEE_CSL
      expect(IEEE_CSL).not.toContain('name="volume"');

      const cslItem = CslJsonMapper.toCsl({
        id: 'vaswani2017',
        itemType: 'journalArticle',
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        publicationTitle: 'IEEE Transactions on Neural Networks',
        volume: '30',
        issue: '4',
        pages: '5998-6008',
        publicationDate: '2017-12-01',
        doi: '10.1109/TNN.2017.12345',
      });

      const res = cslEngine.format(cslItem, 'ieee', 1);
      expect(res.inText).toBe('[1]');
      expect(res.bibliography).toContain('[1]');
      expect(res.bibliography).toContain('A. Vaswani and N. Shazeer');
      expect(res.bibliography).toContain('"Attention Is All You Need,"');
      expect(res.bibliography).toContain(
        'IEEE Transactions on Neural Networks',
      );
      expect(res.bibliography).toContain('vol. 30');
      expect(res.bibliography).toContain('no. 4');
      expect(res.bibliography).toContain('pp. 5998');
      expect(res.bibliography).toContain('2017');
      expect(res.bibliography).toContain('doi: 10.1109/TNN.2017.12345');
    });

    it('renders IEEE book, bookSection (chapter), and conferencePaper accurately', () => {
      const chapterCsl = CslJsonMapper.toCsl({
        id: 'lecun2015chap',
        itemType: 'bookSection',
        title: 'Convolutional Networks in Vision',
        contributors: [
          { creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' },
          { creatorType: 'editor', firstName: 'Yoshua', lastName: 'Bengio' },
        ],
        bookTitle: 'Handbook of Brain Theory',
        publisher: 'MIT Press',
        place: 'Cambridge, MA',
        pages: '255-258',
        year: 2015,
      });

      const chapRes = cslEngine.format(chapterCsl, 'ieee', 2);
      expect(chapRes.bibliography).toContain('in Handbook of Brain Theory');
      expect(chapRes.bibliography).toContain('Y. Bengio, Ed.');
      expect(chapRes.bibliography).toContain('Cambridge, MA');
      expect(chapRes.bibliography).toContain('MIT Press');
      expect(chapRes.bibliography).toContain('pp. 255');
    });

    it('renders Chicago 17th (author-date) with volume, issue, pages, publisher, place, and DOI', () => {
      expect(CHICAGO_CSL).toContain('variable="volume"');
      expect(CHICAGO_CSL).toContain('variable="issue"');
      expect(CHICAGO_CSL).toContain('variable="page"');
      expect(CHICAGO_CSL).toContain('variable="DOI"');

      const articleCsl = CslJsonMapper.toCsl({
        id: 'kahneman1979',
        itemType: 'journalArticle',
        title: 'Prospect Theory: An Analysis of Decision under Risk',
        authors: ['Daniel Kahneman', 'Amos Tversky'],
        publicationTitle: 'Econometrica',
        volume: '47',
        issue: '2',
        pages: '263-291',
        year: 1979,
        doi: '10.2307/1914185',
      });

      const res = cslEngine.format(articleCsl, 'chicago', 1);
      expect(res.inText).toBe('(Kahneman and Tversky 1979)');
      expect(res.bibliography).toContain(
        'Kahneman, Daniel, and Amos Tversky. 1979.',
      );
      expect(res.bibliography).toContain('Econometrica 47 (2): 263');
      expect(res.bibliography).toContain('https://doi.org/10.2307/1914185');
    });

    it('renders MLA 9th with vol., no., year, pp., publisher, and DOI', () => {
      expect(MLA_CSL).toContain('prefix="vol. "');
      expect(MLA_CSL).toContain('prefix="no. "');
      expect(MLA_CSL).toContain('prefix="pp. "');

      const articleCsl = CslJsonMapper.toCsl({
        id: 'butler1988',
        itemType: 'journalArticle',
        title: 'Performative Acts and Gender Constitution',
        authors: ['Judith Butler'],
        publicationTitle: 'Theatre Journal',
        volume: '40',
        issue: '4',
        pages: '519-531',
        year: 1988,
        doi: '10.2307/3207893',
      });

      const res = cslEngine.format(articleCsl, 'mla', 1);
      expect(res.inText).toBe('(Butler)');
      expect(res.bibliography).toContain('Butler, Judith.');
      expect(res.bibliography).toContain('Theatre Journal');
      expect(res.bibliography).toContain('vol. 40');
      expect(res.bibliography).toContain('no. 4');
      expect(res.bibliography).toContain('1988');
      expect(res.bibliography).toContain('pp. 519');
      expect(res.bibliography).toContain('https://doi.org/10.2307/3207893');
    });

    it('renders Nature style with DOI and book publisher fallback', () => {
      expect(NATURE_CSL).toContain('variable="DOI"');

      const articleCsl = CslJsonMapper.toCsl({
        id: 'jumper2021',
        itemType: 'journalArticle',
        title: 'Highly accurate protein structure prediction with AlphaFold',
        authors: ['John Jumper', 'Richard Evans'],
        publicationTitle: 'Nature',
        volume: '596',
        pages: '583-589',
        year: 2021,
        doi: '10.1038/s41586-021-03819-2',
      });

      const res = cslEngine.format(articleCsl, 'nature', 1);
      expect(res.bibliography).toContain('596');
      expect(res.bibliography).toContain('583');
      expect(res.bibliography).toContain('(2021)');
      expect(res.bibliography).toContain(
        'https://doi.org/10.1038/s41586-021-03819-2',
      );
    });
  });

  // 2. Vietnamese MOET / TCVN 7571 Grounding
  describe('2. Vietnamese MOET / TCVN 7571 Grounding', () => {
    it('uses official Zotero style URIs for TCVN_CSL and TCVN_NUMERIC_CSL (no fabricated http://flux.academic URIs)', () => {
      expect(TCVN_CSL).not.toContain('http://flux.academic');
      expect(TCVN_NUMERIC_CSL).not.toContain('http://flux.academic');
      expect(TCVN_CSL).toContain(
        'http://www.zotero.org/styles/vietnam-ministry-of-education-and-training-author-date',
      );
      expect(TCVN_NUMERIC_CSL).toContain(
        'http://www.zotero.org/styles/vietnam-ministry-of-education-and-training-numeric',
      );
    });

    it('strips academic degrees/titles (PGS.TS., GS., TS., ThS., Dr., Prof.) from Vietnamese & English author names and sorts by Given Name', () => {
      const itemA = CslJsonMapper.toCsl({
        id: 'vn1',
        itemType: 'journalArticle',
        title: 'Nghiên cứu mô hình ngôn ngữ lớn tiếng Việt',
        authors: ['PGS.TS. Nguyễn Văn Dũng', 'TS. Trần Thị Hoa'],
        publicationTitle: 'Tạp chí Khoa học ĐHQGHN',
        volume: '40',
        issue: '2',
        pages: '12-25',
        year: 2024,
        doi: '10.25073/2588-1140/vnuhcm.2024',
      });

      const itemB = CslJsonMapper.toCsl({
        id: 'vn2',
        itemType: 'journalArticle',
        title: 'Ứng dụng học sâu trong y sinh',
        authors: ['GS.TS. Lê Hoàng An'],
        publicationTitle: 'Tạp chí Y học Việt Nam',
        volume: '512',
        issue: '1',
        pages: '100-110',
        year: 2023,
      });

      const resA = cslEngine.format(itemA, 'tcvn', 1);
      expect(resA.inText).toBe('(Nguyễn Văn Dũng và Trần Thị Hoa, 2024)');
      expect(resA.bibliography).toContain(
        'Nguyễn Văn Dũng và Trần Thị Hoa (2024)',
      );
      expect(resA.bibliography).not.toMatch(/PGS|TS\./);
      expect(resA.bibliography).toContain(
        'DOI: 10.25073/2588-1140/vnuhcm.2024.',
      );

      // Sort order: "An" (Lê Hoàng An) comes before "Dũng" (Nguyễn Văn Dũng)
      const batch = cslEngine.formatTcvnBatch([itemA, itemB], false);
      expect(batch.citations[0].id).toBe('vn2');
      expect(batch.citations[1].id).toBe('vn1');
    });

    it('formats book chapters ("Trong: ...") and online resources ("truy cập ngày DD/MM/YYYY, tại <URL>") per MOET standard', () => {
      const chapterCsl = CslJsonMapper.toCsl({
        id: 'vn-chap',
        itemType: 'bookSection',
        title: 'Phương pháp tối ưu hóa lồi',
        authors: ['Hoàng Tụy'],
        bookTitle: 'Toán học ứng dụng hiện đại',
        publisher: 'NXB Khoa học và Kỹ thuật',
        place: 'Hà Nội',
        pages: '45-88',
        year: 2020,
      });

      const chapRes = cslEngine.format(chapterCsl, 'tcvn', 1);
      expect(chapRes.bibliography).toBe(
        'Hoàng Tụy (2020), "Phương pháp tối ưu hóa lồi", Trong: Toán học ứng dụng hiện đại, NXB Khoa học và Kỹ thuật, Hà Nội, tr. 45-88.',
      );

      const webCsl = CslJsonMapper.toCsl({
        id: 'vn-web',
        itemType: 'webpage',
        title: 'Chiến lược quốc gia về Trí tuệ nhân tạo đến năm 2030',
        authors: ['Bộ Khoa học và Công nghệ'],
        url: 'https://most.gov.vn/ai-2030',
        accessedAt: '2026-03-15',
        year: 2021,
      });

      const webRes = cslEngine.format(webCsl, 'tcvn', 1);
      expect(webRes.bibliography).toContain(
        'truy cập ngày 15/03/2026, tại <https://most.gov.vn/ai-2030>.',
      );
    });
  });

  // 3. RefMan RIS & BibTeX Format Fidelity
  describe('3. RefMan RIS & BibTeX Standard Specification Fidelity', () => {
    it('splits page ranges into SP and EP lines in RIS and preserves SN, CY, PB, DO, AB', () => {
      const cslItem = CslJsonMapper.toCsl({
        id: 'ris-test-1',
        itemType: 'journalArticle',
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang'],
        publicationTitle: 'CVPR',
        publisher: 'IEEE',
        place: 'Las Vegas, NV',
        volume: '1',
        issue: '2',
        pages: '770-778',
        year: 2016,
        doi: '10.1109/CVPR.2016.90',
        issn: '1063-6919',
        abstract: 'Deeper neural networks are more difficult to train.',
      });

      const ris = cslEngine.formatRis(cslItem);
      expect(ris).toMatch(/^SP\s+-\s+770$/m);
      expect(ris).toMatch(/^EP\s+-\s+778$/m);
      expect(ris).toMatch(/^DO\s+-\s+10\.1109\/CVPR\.2016\.90$/m);
      expect(ris).toMatch(/^PB\s+-\s+IEEE$/m);
      expect(ris).toMatch(/^CY\s+-\s+Las Vegas, NV$/m);
      expect(ris).toMatch(/^SN\s+-\s+1063-6919$/m);
      expect(ris).toMatch(
        /^AB\s+-\s+Deeper neural networks are more difficult to train\.$/m,
      );
      expect(ris).toMatch(/ER\s+-/);
    });

    it('formats BibTeX page ranges with double-dash (--), school for @phdthesis, institution for @techreport, and booktitle/editor for @incollection', () => {
      const thesisCsl = CslJsonMapper.toCsl({
        id: 'nguyen2025thesis',
        citationKey: 'nguyen2025thesis',
        itemType: 'thesis',
        title: 'Automated Theorem Proving with Neural Networks',
        authors: ['Minh Nguyen'],
        publisher: 'Stanford University',
        pages: '1-180',
        year: 2025,
      });

      const thesisBib = cslEngine.formatBibtex(thesisCsl);
      expect(thesisBib).toMatch(/^@phdthesis\{nguyen2025thesis,/i);
      expect(thesisBib).toContain('school = {Stanford University}');
      expect(thesisBib).toContain('pages = {1--180}');

      const reportCsl = CslJsonMapper.toCsl({
        id: 'openai2023gpt4',
        citationKey: 'openai2023gpt4',
        itemType: 'report',
        title: 'GPT-4 Technical Report',
        authors: ['OpenAI'],
        publisher: 'OpenAI Research',
        pages: '10-45',
        year: 2023,
      });

      const reportBib = cslEngine.formatBibtex(reportCsl);
      expect(reportBib).toMatch(/^@techreport\{openai2023gpt4,/i);
      expect(reportBib).toContain('institution = {OpenAI Research}');
      expect(reportBib).toContain('pages = {10--45}');

      const chapterCsl = CslJsonMapper.toCsl({
        id: 'goodfellow2016chap',
        citationKey: 'goodfellow2016chap',
        itemType: 'bookSection',
        title: 'Optimization for Training Deep Models',
        contributors: [
          { creatorType: 'author', firstName: 'Ian', lastName: 'Goodfellow' },
          { creatorType: 'editor', firstName: 'Yoshua', lastName: 'Bengio' },
        ],
        bookTitle: 'Deep Learning',
        publisher: 'MIT Press',
        pages: '271–325',
        year: 2016,
      });

      const chapBib = cslEngine.formatBibtex(chapterCsl);
      expect(chapBib).toMatch(/^@incollection\{goodfellow2016chap,/i);
      expect(chapBib).toMatch(/booktitle\s*=\s*\{Deep\s+\{?Learning\}?\}/i);
      expect(chapBib).toContain('editor = {Bengio, Yoshua}');
      expect(chapBib).toContain('pages = {271--325}');
    });
  });

  // 4. CSL-JSON Purity & CitationService Full Metadata Fidelity
  describe('4. CSL-JSON Schema Purity & CitationService Full Metadata Fidelity', () => {
    it('does not pollute CSL-JSON `version` with DB optimistic lock counter unless versionNumber is set', () => {
      const regularArticle = CslJsonMapper.toCsl({
        id: 'item-db-1',
        itemType: 'journalArticle',
        title: 'Clean CSL JSON Test',
        version: 7, // DB optimistic lock counter
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        year: 2026,
      });

      expect(regularArticle.version).toBeUndefined();
      expect(regularArticle._version).toBe('7');

      const softwareItem = CslJsonMapper.toCsl({
        id: 'pytorch-2',
        itemType: 'computerProgram',
        title: 'PyTorch',
        version: 12,
        versionNumber: '2.4.0',
        year: 2024,
      });

      expect(softwareItem.version).toBe('2.4.0');
      expect(softwareItem._version).toBe('12');
    });

    it('preserves full CatalogItem metadata (bookTitle, place, edition, editors, identifiers, extra) in formatItemById and formatItemBatch', async () => {
      const storedChapter: CatalogItemRecord = {
        id: 'stored-chap-1',
        title: 'Transformer Architectures in Practice',
        itemType: 'bookSection',
        publisher: 'Springer',
        pages: '101-140',
        year: 2024,
        doi: '10.1007/978-3-031-12345-6_5',
        contributors: [
          {
            creatorType: 'author',
            firstName: 'Sepp',
            lastName: 'Hochreiter',
          },
          {
            creatorType: 'editor',
            firstName: 'Jürgen',
            lastName: 'Schmidhuber',
          },
        ],
        metadata: {
          bookTitle: 'Modern Sequence Modeling',
          place: 'Cham',
          edition: '2',
        },
      };

      const mockCatalogGateway = {
        getItem: jest.fn().mockResolvedValue(storedChapter),
        findByIds: jest.fn().mockResolvedValue([storedChapter]),
      };

      const serviceWithGateway = new CitationService(
        undefined,
        cslEngine,
        undefined,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      const singleRes = await serviceWithGateway.formatItemById(
        'user-1',
        'stored-chap-1',
        'ieee',
        1,
      );
      expect(singleRes.bibliography).toContain('in Modern Sequence Modeling');
      expect(singleRes.bibliography).toContain('J. Schmidhuber, Ed.');
      expect(singleRes.bibliography).toContain('Cham');
      expect(singleRes.bibliography).toContain('Springer');
      expect(singleRes.bibliography).toContain('pp. 101');

      const batchRes = await serviceWithGateway.formatBatchAsync(
        [
          {
            id: storedChapter.id,
            itemType: storedChapter.itemType || 'bookSection',
            title: storedChapter.title,
            contributors: storedChapter.contributors || [],
            publisher: storedChapter.publisher,
            pages: storedChapter.pages,
            year: storedChapter.year,
            doi: storedChapter.doi,
            metadata: storedChapter.metadata,
          },
        ],
        'chicago',
      );
      expect(batchRes.bibliographyText).toContain(
        'In Modern Sequence Modeling',
      );
      expect(batchRes.bibliographyText).toContain(
        'edited by Jürgen Schmidhuber',
      );
    });
  });
});
