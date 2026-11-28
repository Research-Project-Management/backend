import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { extractItemCitationAliases } from '@/modules/library/citation/domain/citation.domain';
import { TcvnCitationFormatterService } from '@/modules/library/citation/domain/tcvn-citation.domain';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { CslStyleFormatterService } from '@/modules/library/citation/services/csl-style-formatter.service';
import { CslItemData } from '@/modules/library/citation/types/citation.types';

describe('Vietnamese & Cultural Citation Engine', () => {
  let engine: CslEngineService;

  beforeAll(() => {
    engine = new CslEngineService();
    engine.initTemplates();
  });

  describe('CslJsonMapper Name & Date Parsing', () => {
    it('parses Vietnamese 2/3/4-word names, compound surnames (Họ kép), and unaccented ASCII Vietnamese names', () => {
      expect(CslJsonMapper.parseStringName('Nguyễn Văn An')).toEqual({
        family: 'Nguyễn',
        given: 'Văn An',
      });
      expect(CslJsonMapper.parseStringName('Trần Thị Bích Ngọc')).toEqual({
        family: 'Trần',
        given: 'Thị Bích Ngọc',
      });
      expect(CslJsonMapper.parseStringName('Lê Bình')).toEqual({
        family: 'Lê',
        given: 'Bình',
      });
      expect(CslJsonMapper.parseStringName('Phan Huy Chú')).toEqual({
        family: 'Phan Huy',
        given: 'Chú',
      });
      expect(CslJsonMapper.parseStringName('Nguyễn Phúc Ánh')).toEqual({
        family: 'Nguyễn Phúc',
        given: 'Ánh',
      });
      expect(CslJsonMapper.parseStringName('Nguyen Van An')).toEqual({
        family: 'Nguyen',
        given: 'Van An',
      });
      expect(CslJsonMapper.parseStringName('Tran Duc Thao')).toEqual({
        family: 'Tran',
        given: 'Duc Thao',
      });
    });

    it('preserves Vietnamese and international institutions (including comma-containing names) as literals and handles Western/single-word names', () => {
      expect(
        CslJsonMapper.parseStringName('Đại học Bách Khoa Hà Nội'),
      ).toEqual({ literal: 'Đại học Bách Khoa Hà Nội' });
      expect(CslJsonMapper.parseStringName('Bộ Giáo dục và Đào tạo')).toEqual({
        literal: 'Bộ Giáo dục và Đào tạo',
      });
      expect(
        CslJsonMapper.parseStringName(
          'Viện Hàn lâm Khoa học và Công nghệ Việt Nam',
        ),
      ).toEqual({ literal: 'Viện Hàn lâm Khoa học và Công nghệ Việt Nam' });
      expect(
        CslJsonMapper.parseStringName('University of California, Berkeley'),
      ).toEqual({ literal: 'University of California, Berkeley' });
      expect(
        CslJsonMapper.parseStringName('World Health Organization'),
      ).toEqual({ literal: 'World Health Organization' });
      expect(CslJsonMapper.parseStringName('Preskill, John')).toEqual({
        family: 'Preskill',
        given: 'John',
      });
      expect(CslJsonMapper.parseStringName('Alan Turing')).toEqual({
        family: 'Turing',
        given: 'Alan',
      });
      expect(CslJsonMapper.parseStringName('Plato')).toEqual({
        family: 'Plato',
      });
      expect(CslJsonMapper.parseCslDate('May–June 2023')).toEqual({
        'date-parts': [
          [2023, 5],
          [2023, 6],
        ],
      });
    });

    it('self-heals inverted or single-field Vietnamese creator inputs while preserving correctly split two-field authors', () => {
      const inverted = CslJsonMapper.toCsl({
        id: 'test-1',
        itemType: 'journalArticle',
        title: 'Nghiên cứu trí tuệ nhân tạo',
        creators: [
          { creatorType: 'author', firstName: 'Nguyễn Văn', lastName: 'An' },
        ],
      } as never);
      expect(inverted.author?.[0]).toMatchObject({
        family: 'Nguyễn',
        given: 'Văn An',
      });

      const inLastName = CslJsonMapper.toCsl({
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
      } as never);
      expect(inLastName.author?.[0]).toMatchObject({
        family: 'Trần',
        given: 'Thị Bích Ngọc',
      });

      const alreadySplit = CslJsonMapper.toCsl({
        id: 'test-3',
        itemType: 'journalArticle',
        title: 'Bài báo mẫu',
        creators: [
          { creatorType: 'author', firstName: 'Văn An', lastName: 'Nguyễn' },
        ],
      } as never);
      expect(alreadySplit.author?.[0]).toMatchObject({
        family: 'Nguyễn',
        given: 'Văn An',
      });
    });
  });

  describe('APA, IEEE, TCVN & Zero-Config Auto Formatting', () => {
    it('formats Vietnamese personal and institutional authors in APA and IEEE styles', () => {
      const twoAuthors: CslItemData = {
        id: 'vn-2',
        type: 'article-journal',
        title: 'Mô hình học máy trong y tế',
        author: [
          { family: 'Nguyễn', given: 'Văn An' },
          { family: 'Trần', given: 'Thị Bình' },
        ],
        issued: { 'date-parts': [[2024]] },
      };
      const apaRes = engine.formatBatch([twoAuthors], 'apa');
      expect(apaRes.citations[0].inText).toBe('(Nguyễn & Trần, 2024)');
      expect(apaRes.citations[0].bibliography).toContain(
        'Nguyễn, V. A., & Trần, T. B. (2024).',
      );

      const orgItem: CslItemData = {
        id: 'vn-org',
        type: 'report',
        title: 'Chiến lược phát triển giáo dục đại học 2030',
        author: [{ literal: 'Bộ Giáo dục và Đào tạo' }],
        issued: { 'date-parts': [[2022]] },
      };
      const orgApa = engine.formatBatch([orgItem], 'apa');
      expect(orgApa.citations[0].inText).toBe('(Bộ Giáo dục và Đào tạo, 2022)');

      const ieeeRes = engine.formatBatch(
        [
          {
            id: 'vn-ieee',
            type: 'article-journal',
            title: 'Nghiên cứu thuật toán phân cụm tối ưu',
            author: [{ family: 'Nguyễn', given: 'Văn An' }],
            issued: { 'date-parts': [[2023]] },
          },
        ],
        'ieee',
      );
      expect(ieeeRes.citations[0].inText).toBe('[1]');
      expect(ieeeRes.citations[0].bibliography).toContain('V. A. Nguyễn');
    });

    it('formats TCVN and TCVN-Numeric according to MoET rules ("và", "và c.s.", natural Vietnamese names, inverted foreign names)', () => {
      const singleVn = engine.format(
        {
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
        },
        'tcvn',
      );
      expect(singleVn.inText).toBe('(Nguyễn Văn An, 2024)');
      expect(singleVn.bibliography).toBe(
        'Nguyễn Văn An (2024), "Nghiên cứu ứng dụng Trí tuệ nhân tạo trong xử lý ngôn ngữ tự nhiên", Tạp chí Khoa học & Công nghệ, tập 15(2), tr. 45-52.',
      );

      const twoVn = engine.format(
        {
          id: 'vn-tcvn-2',
          type: 'article-journal',
          title: 'Học sâu trong chẩn đoán y tế',
          author: [
            { family: 'Nguyễn', given: 'Văn An' },
            { family: 'Trần', given: 'Thị Bình' },
          ],
          issued: { 'date-parts': [[2023]] },
        },
        'tcvn',
      );
      expect(twoVn.inText).toBe('(Nguyễn Văn An và Trần Thị Bình, 2023)');

      const fourVn = engine.format(
        {
          id: 'vn-tcvn-4',
          type: 'article-journal',
          title: 'Hệ thống hỏi đáp tiếng Việt',
          author: [
            { family: 'Nguyễn', given: 'Văn An' },
            { family: 'Trần', given: 'Thị Bình' },
            { family: 'Lê', given: 'Văn Cường' },
            { family: 'Vũ', given: 'Đình Dũng' },
          ],
          issued: { 'date-parts': [[2024]] },
        },
        'tcvn',
      );
      expect(fourVn.inText).toBe('(Nguyễn Văn An và c.s., 2024)');
      expect(fourVn.bibliography).toContain(
        'Nguyễn Văn An, Trần Thị Bình, Lê Văn Cường và c.s. (2024)',
      );

      const foreignTcvn = engine.format(
        {
          id: 'foreign-tcvn',
          type: 'article-journal',
          title: 'Computing Machinery and Intelligence',
          'container-title': 'Mind',
          volume: '59',
          issue: '236',
          page: '433-460',
          author: [{ family: 'Turing', given: 'Alan M.' }],
          issued: { 'date-parts': [[1950]] },
        },
        'tcvn',
      );
      expect(foreignTcvn.inText).toBe('(Turing, 1950)');
      expect(foreignTcvn.bibliography).toBe(
        'Turing, A. M. (1950), "Computing Machinery and Intelligence", Mind, tập 59(236), tr. 433-460.',
      );

      const numericVn = engine.format(
        {
          id: 'vn-numeric',
          type: 'book',
          title: 'Giáo trình Cơ sở Dữ liệu',
          publisher: 'NXB Đại học Quốc gia Hà Nội',
          author: [{ family: 'Đỗ', given: 'Trung Tuấn' }],
          issued: { 'date-parts': [[2021]] },
        },
        'tcvn-numeric',
        5,
      );
      expect(numericVn.inText).toBe('[5]');
      expect(numericVn.bibliography).toBe(
        '[5] Đỗ Trung Tuấn (2021), Giáo trình Cơ sở Dữ liệu, NXB Đại học Quốc gia Hà Nội.',
      );
    });

    it('sorts Vietnamese section first by Given Name (Tên), preserves _itemId across reordering, and handles auto / auto-numeric modes', () => {
      const mixed: CslItemData[] = [
        {
          id: 'item-foreign',
          _itemId: 'uuid-foreign',
          type: 'article-journal',
          title: 'Attention is All You Need',
          author: [{ family: 'Vaswani', given: 'Ashish' }],
          issued: { 'date-parts': [[2017]] },
        },
        {
          id: 'item-cuong',
          _itemId: 'uuid-cuong',
          type: 'article-journal',
          title: 'Xử lý tiếng nói tiếng Việt',
          author: [{ family: 'Lê', given: 'Văn Cường' }],
          issued: { 'date-parts': [[2023]] },
        },
        {
          id: 'item-an',
          _itemId: 'uuid-an',
          type: 'article-journal',
          title: 'Học sâu ứng dụng',
          author: [{ family: 'Nguyễn', given: 'Văn An' }],
          issued: { 'date-parts': [[2024]] },
        },
        {
          id: 'item-binh',
          _itemId: 'uuid-binh',
          type: 'article-journal',
          title: 'Thị giác máy tính',
          author: [{ family: 'Trần', given: 'Thị Bình' }],
          issued: { 'date-parts': [[2022]] },
        },
      ];

      const tcvnNumeric = engine.formatBatch(mixed, 'tcvn-numeric');
      expect(tcvnNumeric.citations.map((c) => c.id)).toEqual([
        'item-an',
        'item-binh',
        'item-cuong',
        'item-foreign',
      ]);
      expect(
        (tcvnNumeric.citations[0] as unknown as { itemId?: string }).itemId,
      ).toBe('uuid-an');
      expect(tcvnNumeric.combinedInText).toBe('[1, 2, 3, 4]');

      const autoMixed = engine.formatBatch(mixed, 'auto');
      expect(autoMixed.citations[0].inText).toBe('(Nguyễn Văn An, 2024)');
      expect(autoMixed.citations[3].inText).toBe('(Vaswani, 2017)');

      const autoNumeric = engine.formatBatch(
        [mixed[2], mixed[0]],
        'auto-numeric',
      );
      expect(autoNumeric.combinedInText).toBe('[1, 2]');
      expect(autoNumeric.citations[0].bibliography).toContain(
        '[1] Nguyễn Văn An (2024)',
      );
      expect(autoNumeric.citations[1].bibliography).toContain(
        '[2] Vaswani, A. (2017)',
      );
    });

    it('guards short ASCII surnames (Chu, Ma, Le) against Vietnamese false positives and escapes BibTeX special characters', () => {
      expect(
        TcvnCitationFormatterService.isVietnameseAuthor({
          family: 'Chu',
          given: 'Michael',
        }),
      ).toBe(false);
      expect(
        TcvnCitationFormatterService.isVietnameseAuthor({
          family: 'Ma',
          given: 'Wei',
        }),
      ).toBe(false);
      expect(
        TcvnCitationFormatterService.isVietnameseAuthor({
          family: 'Le',
          given: 'Jean',
        }),
      ).toBe(false);
      expect(
        TcvnCitationFormatterService.isVietnameseAuthor({
          family: 'Le',
          given: 'Van An',
        }),
      ).toBe(true);

      expect(
        extractItemCitationAliases({
          id: 'item-1',
          citationKey: 'primary2024',
          extra: 'Citation Key: legacy2023\ntex.ids: alt2022a, alt2022b',
        } as never),
      ).toEqual(
        expect.arrayContaining([
          'primary2024',
          'legacy2023',
          'alt2022a',
          'alt2022b',
        ]),
      );

      const styleFormatter = new CslStyleFormatterService(
        new TcvnCitationFormatterService(),
      );
      expect(
        styleFormatter.escapeBibtexValue(
          '50% gain in R&D #1_test with $\\alpha_1$',
          'title',
        ),
      ).toBe('50\\% gain in R\\&D \\#1\\_test with $\\alpha_1$');
      expect(
        styleFormatter.escapeBibtexValue(
          'https://example.com/a_b?x=1&y=2#sec',
          'url',
        ),
      ).toBe('https://example.com/a_b?x=1&y=2#sec');
    });
  });
});
