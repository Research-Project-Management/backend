import { CslJsonMapper } from '../../../src/modules/library/citation/utils/csl-json.mapper';
import { CslEngineService } from '../../../src/modules/library/citation/services/csl-engine.service';
import { CslItemData } from '../../../src/modules/library/citation/types/csl-json.types';

describe('Vietnamese & Cultural Citation Engine', () => {
  let engine: CslEngineService;

  beforeAll(() => {
    engine = new CslEngineService();
    engine.initTemplates();
  });

  describe('CslJsonMapper.parseStringName', () => {
    it('correctly parses standard Vietnamese 3-word names (Họ - Đệm - Tên)', () => {
      const parsed = CslJsonMapper.parseStringName('Nguyễn Văn An');
      expect(parsed.family).toBe('Nguyễn');
      expect(parsed.given).toBe('Văn An');
      expect(parsed.literal).toBeUndefined();
    });

    it('correctly parses Vietnamese 4-word names', () => {
      const parsed = CslJsonMapper.parseStringName('Trần Thị Bích Ngọc');
      expect(parsed.family).toBe('Trần');
      expect(parsed.given).toBe('Thị Bích Ngọc');
    });

    it('correctly parses Vietnamese 2-word names with diacritics', () => {
      const parsed = CslJsonMapper.parseStringName('Lê Bình');
      expect(parsed.family).toBe('Lê');
      expect(parsed.given).toBe('Bình');
    });

    it('correctly recognizes Vietnamese compound surnames (Họ kép)', () => {
      const parsed = CslJsonMapper.parseStringName('Phan Huy Chú');
      expect(parsed.family).toBe('Phan Huy');
      expect(parsed.given).toBe('Chú');

      const parsed2 = CslJsonMapper.parseStringName('Nguyễn Phúc Ánh');
      expect(parsed2.family).toBe('Nguyễn Phúc');
      expect(parsed2.given).toBe('Ánh');
    });

    it('correctly parses unaccented ASCII Vietnamese names', () => {
      const parsed1 = CslJsonMapper.parseStringName('Nguyen Van An');
      expect(parsed1.family).toBe('Nguyen');
      expect(parsed1.given).toBe('Van An');

      const parsed2 = CslJsonMapper.parseStringName('Tran Duc Thao');
      expect(parsed2.family).toBe('Tran');
      expect(parsed2.given).toBe('Duc Thao');
    });

    it('preserves institutional authors in Vietnamese as literals', () => {
      const parsed1 = CslJsonMapper.parseStringName('Đại học Bách Khoa Hà Nội');
      expect(parsed1.literal).toBe('Đại học Bách Khoa Hà Nội');
      expect(parsed1.family).toBeUndefined();

      const parsed2 = CslJsonMapper.parseStringName('Bộ Giáo dục và Đào tạo');
      expect(parsed2.literal).toBe('Bộ Giáo dục và Đào tạo');

      const parsed3 = CslJsonMapper.parseStringName(
        'Viện Hàn lâm Khoa học và Công nghệ Việt Nam',
      );
      expect(parsed3.literal).toBe(
        'Viện Hàn lâm Khoa học và Công nghệ Việt Nam',
      );
    });

    it('preserves international institutional authors as literals', () => {
      const parsed1 = CslJsonMapper.parseStringName('Google DeepMind');
      expect(parsed1.literal).toBe('Google DeepMind');

      const parsed2 = CslJsonMapper.parseStringName(
        'World Health Organization',
      );
      expect(parsed2.literal).toBe('World Health Organization');
    });

    it('correctly handles comma-separated names without alteration', () => {
      const parsed1 = CslJsonMapper.parseStringName('Preskill, John');
      expect(parsed1.family).toBe('Preskill');
      expect(parsed1.given).toBe('John');

      const parsed2 = CslJsonMapper.parseStringName('Nguyễn, Văn An');
      expect(parsed2.family).toBe('Nguyễn');
      expect(parsed2.given).toBe('Văn An');
    });

    it('retains Western First-Last parsing for non-Vietnamese authors', () => {
      const parsed = CslJsonMapper.parseStringName('Alan Turing');
      expect(parsed.family).toBe('Turing');
      expect(parsed.given).toBe('Alan');
    });

    it('handles single-word authors', () => {
      const parsed = CslJsonMapper.parseStringName('Plato');
      expect(parsed.family).toBe('Plato');
      expect(parsed.given).toBeUndefined();
    });
  });

  describe('CslJsonMapper.mapToCslItem (Self-Healing Two-Field Input)', () => {
    it('self-heals inverted Western form where firstName has Vietnamese surname', () => {
      const item: any = {
        id: 'test-1',
        itemType: 'journalArticle',
        title: 'Nghiên cứu trí tuệ nhân tạo',
        creators: [
          {
            creatorType: 'author',
            firstName: 'Nguyễn Văn',
            lastName: 'An',
          },
        ],
      };

      const csl = CslJsonMapper.toCsl(item);
      expect(csl.author).toBeDefined();
      expect(csl.author![0].family).toBe('Nguyễn');
      expect(csl.author![0].given).toBe('Văn An');
    });

    it('self-heals full name entered entirely in lastName with empty firstName', () => {
      const item: any = {
        id: 'test-2',
        itemType: 'journalArticle',
        title: 'Lịch sử văn học Việt Nam',
        creators: [
          {
            creatorType: 'author',
            firstName: '',
            lastName: 'Trần Thị Bích Ngọc',
          },
        ],
      };

      const csl = CslJsonMapper.toCsl(item);
      expect(csl.author![0].family).toBe('Trần');
      expect(csl.author![0].given).toBe('Thị Bích Ngọc');
    });

    it('maintains correctly-split two-field authors', () => {
      const item: any = {
        id: 'test-3',
        itemType: 'journalArticle',
        title: 'Bài báo mẫu',
        creators: [
          {
            creatorType: 'author',
            firstName: 'Văn An',
            lastName: 'Nguyễn',
          },
        ],
      };

      const csl = CslJsonMapper.toCsl(item);
      expect(csl.author![0].family).toBe('Nguyễn');
      expect(csl.author![0].given).toBe('Văn An');
    });
  });

  describe('End-to-End Citation Formatting with CslEngineService', () => {
    it('formats single Vietnamese author properly in APA bibliography and in-text', () => {
      const item: CslItemData = {
        id: 'vn-1',
        type: 'article-journal',
        title: 'Nghiên cứu ứng dụng xử lý ngôn ngữ tự nhiên',
        author: [{ family: 'Nguyễn', given: 'Văn An' }],
        issued: { 'date-parts': [[2023]] },
      };

      const result = engine.formatBatch([item], 'apa');
      expect(result.citations[0].inText).toBe('(Nguyễn, 2023)');
      expect(result.citations[0].bibliography).toContain(
        'Nguyễn, V. A. (2023).',
      );
      expect(result.combinedInText).toBe('(Nguyễn, 2023)');
    });

    it('formats two Vietnamese authors properly in APA (Nguyễn & Trần)', () => {
      const item: CslItemData = {
        id: 'vn-2',
        type: 'article-journal',
        title: 'Mô hình học máy trong y tế',
        author: [
          { family: 'Nguyễn', given: 'Văn An' },
          { family: 'Trần', given: 'Thị Bình' },
        ],
        issued: { 'date-parts': [[2024]] },
      };

      const result = engine.formatBatch([item], 'apa');
      expect(result.citations[0].inText).toBe('(Nguyễn & Trần, 2024)');
      expect(result.citations[0].bibliography).toContain(
        'Nguyễn, V. A., & Trần, T. B. (2024).',
      );
    });

    it('formats institutional Vietnamese author in APA without splitting words', () => {
      const item: CslItemData = {
        id: 'vn-org',
        type: 'report',
        title: 'Chiến lược phát triển giáo dục đại học 2030',
        author: [{ literal: 'Bộ Giáo dục và Đào tạo' }],
        issued: { 'date-parts': [[2022]] },
      };

      const result = engine.formatBatch([item], 'apa');
      expect(result.citations[0].inText).toBe('(Bộ Giáo dục và Đào tạo, 2022)');
      expect(result.citations[0].bibliography).toContain(
        'Bộ Giáo dục và Đào tạo. (2022).',
      );
    });

    it('formats Vietnamese author in IEEE style', () => {
      const item: CslItemData = {
        id: 'vn-ieee',
        type: 'article-journal',
        title: 'Nghiên cứu thuật toán phân cụm tối ưu',
        author: [{ family: 'Nguyễn', given: 'Văn An' }],
        issued: { 'date-parts': [[2023]] },
      };

      const result = engine.formatBatch([item], 'ieee');
      expect(result.citations[0].inText).toBe('[1]');
      expect(result.citations[0].bibliography).toContain('V. A. Nguyễn');
    });
  });

  describe('TCVN / Bộ Giáo dục & Đào tạo Citation Standards', () => {
    it('formats single Vietnamese author with full natural name (no abbreviation or comma inversion)', () => {
      const item: CslItemData = {
        id: 'vn-tcvn-1',
        type: 'article-journal',
        title:
          'Nghiên cứu ứng dụng Trí tuệ nhân tạo trong xử lý ngôn ngữ tự nhiên',
        'container-title': 'Tạp chí Khoa học & Công nghệ',
        volume: '15',
        issue: '2',
        page: '45-52',
        author: [{ family: 'Nguyễn', given: 'Văn An' }],
        issued: { 'date-parts': [[2024]] },
      };

      const result = engine.format(item, 'tcvn');
      expect(result.inText).toBe('(Nguyễn Văn An, 2024)');
      expect(result.bibliography).toBe(
        'Nguyễn Văn An (2024), "Nghiên cứu ứng dụng Trí tuệ nhân tạo trong xử lý ngôn ngữ tự nhiên", Tạp chí Khoa học & Công nghệ, tập 15(2), tr. 45-52.',
      );
    });

    it('formats two Vietnamese authors using "và" connector according to MoET rules', () => {
      const item: CslItemData = {
        id: 'vn-tcvn-2',
        type: 'article-journal',
        title: 'Học sâu trong chẩn đoán y tế',
        author: [
          { family: 'Nguyễn', given: 'Văn An' },
          { family: 'Trần', given: 'Thị Bình' },
        ],
        issued: { 'date-parts': [[2023]] },
      };

      const result = engine.format(item, 'tcvn');
      expect(result.inText).toBe('(Nguyễn Văn An và Trần Thị Bình, 2023)');
      expect(result.bibliography).toContain(
        'Nguyễn Văn An và Trần Thị Bình (2023), "Học sâu trong chẩn đoán y tế".',
      );
    });

    it('formats 3+ authors using "và c.s." in-text according to MoET rules', () => {
      const item: CslItemData = {
        id: 'vn-tcvn-3',
        type: 'article-journal',
        title: 'Hệ thống hỏi đáp tiếng Việt',
        author: [
          { family: 'Nguyễn', given: 'Văn An' },
          { family: 'Trần', given: 'Thị Bình' },
          { family: 'Lê', given: 'Văn Cường' },
          { family: 'Vũ', given: 'Đình Dũng' },
        ],
        issued: { 'date-parts': [[2024]] },
      };

      const result = engine.format(item, 'tcvn');
      expect(result.inText).toBe('(Nguyễn Văn An và c.s., 2024)');
      expect(result.bibliography).toContain(
        'Nguyễn Văn An, Trần Thị Bình, Lê Văn Cường và c.s. (2024)',
      );
    });

    it('formats foreign authors in TCVN with inverted surname in bibliography and surname only in-text', () => {
      const item: CslItemData = {
        id: 'foreign-tcvn',
        type: 'article-journal',
        title: 'Computing Machinery and Intelligence',
        'container-title': 'Mind',
        volume: '59',
        issue: '236',
        page: '433-460',
        author: [{ family: 'Turing', given: 'Alan M.' }],
        issued: { 'date-parts': [[1950]] },
      };

      const result = engine.format(item, 'tcvn');
      expect(result.inText).toBe('(Turing, 1950)');
      expect(result.bibliography).toBe(
        'Turing, A. M. (1950), "Computing Machinery and Intelligence", Mind, tập 59(236), tr. 433-460.',
      );
    });

    it('formats TCVN-Numeric with [index] bracket numbering', () => {
      const item: CslItemData = {
        id: 'vn-numeric',
        type: 'book',
        title: 'Giáo trình Cơ sở Dữ liệu',
        publisher: 'NXB Đại học Quốc gia Hà Nội',
        author: [{ family: 'Đỗ', given: 'Trung Tuấn' }],
        issued: { 'date-parts': [[2021]] },
      };

      const result = engine.format(item, 'tcvn-numeric', 5);
      expect(result.inText).toBe('[5]');
      expect(result.bibliography).toBe(
        '[5] Đỗ Trung Tuấn (2021), Giáo trình Cơ sở Dữ liệu, NXB Đại học Quốc gia Hà Nội.',
      );
    });

    it('sorts batch bibliography alphabetically by Given Name (Tên) for Vietnamese authors and prioritizes Vietnamese section', () => {
      const items: CslItemData[] = [
        {
          id: 'item-foreign',
          type: 'article-journal',
          title: 'Attention is All You Need',
          author: [{ family: 'Vaswani', given: 'Ashish' }],
          issued: { 'date-parts': [[2017]] },
        },
        {
          id: 'item-cuong',
          type: 'article-journal',
          title: 'Xử lý tiếng nói tiếng Việt',
          author: [{ family: 'Lê', given: 'Văn Cường' }],
          issued: { 'date-parts': [[2023]] },
        },
        {
          id: 'item-an',
          type: 'article-journal',
          title: 'Học sâu ứng dụng',
          author: [{ family: 'Nguyễn', given: 'Văn An' }],
          issued: { 'date-parts': [[2024]] },
        },
        {
          id: 'item-binh',
          type: 'article-journal',
          title: 'Thị giác máy tính',
          author: [{ family: 'Trần', given: 'Thị Bình' }],
          issued: { 'date-parts': [[2022]] },
        },
      ];

      const batchResult = engine.formatBatch(items, 'tcvn-numeric');

      // Check sorting order:
      // 1. Nguyễn Văn An (An -> A)
      // 2. Trần Thị Bình (Bình -> B)
      // 3. Lê Văn Cường (Cường -> C)
      // 4. Vaswani, A. (Foreign -> after Vietnamese)
      expect(batchResult.citations[0].id).toBe('item-an');
      expect(batchResult.citations[0].inText).toBe('[1]');
      expect(batchResult.citations[0].bibliography).toContain(
        '[1] Nguyễn Văn An (2024)',
      );

      expect(batchResult.citations[1].id).toBe('item-binh');
      expect(batchResult.citations[1].inText).toBe('[2]');
      expect(batchResult.citations[1].bibliography).toContain(
        '[2] Trần Thị Bình (2022)',
      );

      expect(batchResult.citations[2].id).toBe('item-cuong');
      expect(batchResult.citations[2].inText).toBe('[3]');
      expect(batchResult.citations[2].bibliography).toContain(
        '[3] Lê Văn Cường (2023)',
      );

      expect(batchResult.citations[3].id).toBe('item-foreign');
      expect(batchResult.citations[3].inText).toBe('[4]');
      expect(batchResult.citations[3].bibliography).toContain(
        '[4] Vaswani, A. (2017)',
      );

      expect(batchResult.combinedInText).toBe('[1, 2, 3, 4]');
    });
  });

  describe('Automated Detection & Zero-Configuration Auto-Format (style = "auto")', () => {
    it('automatically formats Vietnamese item with natural names when style is "auto"', () => {
      const vnItem: CslItemData = {
        id: 'auto-vn-1',
        type: 'article-journal',
        title: 'Nghiên cứu thị giác máy tính',
        author: [{ family: 'Nguyễn', given: 'Văn An' }],
        issued: { 'date-parts': [[2024]] },
      };

      const result = engine.format(vnItem, 'auto');
      expect(result.styleId).toBe('auto');
      expect(result.inText).toBe('(Nguyễn Văn An, 2024)');
      expect(result.bibliography).toContain('Nguyễn Văn An (2024)');
    });

    it('automatically formats foreign item with international standard when style is "auto"', () => {
      const foreignItem: CslItemData = {
        id: 'auto-foreign-1',
        type: 'article-journal',
        title: 'Computing Machinery and Intelligence',
        author: [{ family: 'Turing', given: 'Alan M.' }],
        issued: { 'date-parts': [[1950]] },
      };

      const result = engine.format(foreignItem, 'auto');
      expect(result.styleId).toBe('auto');
      expect(result.inText).toBe('(Turing, 1950)');
      expect(result.bibliography).toContain('Turing, A. M.');
    });

    it('automatically groups and sorts mixed collections when batch formatting with "auto"', () => {
      const items: CslItemData[] = [
        {
          id: 'item-foreign',
          type: 'article-journal',
          title: 'Deep Learning',
          author: [{ family: 'Goodfellow', given: 'Ian' }],
          issued: { 'date-parts': [[2016]] },
        },
        {
          id: 'item-vn-binh',
          type: 'article-journal',
          title: 'Học sâu ứng dụng',
          author: [{ family: 'Trần', given: 'Thị Bình' }],
          issued: { 'date-parts': [[2023]] },
        },
        {
          id: 'item-vn-an',
          type: 'article-journal',
          title: 'Xử lý tiếng nói tiếng Việt',
          author: [{ family: 'Nguyễn', given: 'Văn An' }],
          issued: { 'date-parts': [[2024]] },
        },
      ];

      const batchResult = engine.formatBatch(items, 'auto');
      expect(batchResult.styleId).toBe('auto');

      // Vietnamese authors are sorted by Given Name first: An (A) -> Bình (B) -> Goodfellow (Foreign)
      expect(batchResult.citations[0].id).toBe('item-vn-an');
      expect(batchResult.citations[0].inText).toBe('(Nguyễn Văn An, 2024)');
      expect(batchResult.citations[0].bibliography).toContain(
        'Nguyễn Văn An (2024)',
      );

      expect(batchResult.citations[1].id).toBe('item-vn-binh');
      expect(batchResult.citations[1].inText).toBe('(Trần Thị Bình, 2023)');
      expect(batchResult.citations[1].bibliography).toContain(
        'Trần Thị Bình (2023)',
      );

      expect(batchResult.citations[2].id).toBe('item-foreign');
      expect(batchResult.citations[2].inText).toBe('(Goodfellow, 2016)');
      expect(batchResult.citations[2].bibliography).toContain(
        'Goodfellow, I. (2016)',
      );
    });

    it('automatically applies numeric formatting with Vietnamese natural names when style is "auto-numeric"', () => {
      const items: CslItemData[] = [
        {
          id: 'item-vn-an',
          type: 'article-journal',
          title: 'Xử lý tiếng nói tiếng Việt',
          author: [{ family: 'Nguyễn', given: 'Văn An' }],
          issued: { 'date-parts': [[2024]] },
        },
        {
          id: 'item-foreign',
          type: 'article-journal',
          title: 'Deep Learning',
          author: [{ family: 'Goodfellow', given: 'Ian' }],
          issued: { 'date-parts': [[2016]] },
        },
      ];

      const batchResult = engine.formatBatch(items, 'auto-numeric');
      expect(batchResult.styleId).toBe('auto-numeric');
      expect(batchResult.combinedInText).toBe('[1, 2]');
      expect(batchResult.citations[0].inText).toBe('[1]');
      expect(batchResult.citations[0].bibliography).toContain(
        '[1] Nguyễn Văn An (2024)',
      );
      expect(batchResult.citations[1].inText).toBe('[2]');
      expect(batchResult.citations[1].bibliography).toContain(
        '[2] Goodfellow, I. (2016)',
      );
    });

    it('falls back cleanly to APA when a batch contains only foreign authors and style is "auto"', () => {
      const items: CslItemData[] = [
        {
          id: 'item-1',
          type: 'article-journal',
          title: 'Paper 1',
          author: [{ family: 'Smith', given: 'John' }],
          issued: { 'date-parts': [[2020]] },
        },
        {
          id: 'item-2',
          type: 'article-journal',
          title: 'Paper 2',
          author: [{ family: 'Brown', given: 'Alice' }],
          issued: { 'date-parts': [[2021]] },
        },
      ];

      const batchResult = engine.formatBatch(items, 'auto');
      expect(batchResult.styleId).toBe('auto');
      expect(batchResult.citations.length).toBe(2);
      expect(batchResult.citations[0].bibliography).toContain(
        'Smith, J. (2020)',
      );
      expect(batchResult.citations[1].bibliography).toContain(
        'Brown, A. (2021)',
      );
      expect(batchResult.bibliographyText).toContain('Brown, A.');
      expect(batchResult.bibliographyText).toContain('Smith, J.');
    });
  });
});
