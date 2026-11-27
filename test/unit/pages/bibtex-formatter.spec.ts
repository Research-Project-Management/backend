import {
  toBibtexValue,
  sanitizeCitationKey,
  formatBibtexName,
} from '@/modules/pages/citations/domain/bibtex-formatter.domain';
import { buildBibEntryFromInput } from '@/modules/pages/citations/domain/bib-entry.mapper';

describe('BibTeX Formatter & Mapper', () => {
  it('converts Unicode en-dash/em-dash to -- without corrupting Vietnamese characters like â', () => {
    expect(toBibtexValue('10\u201320', { field: 'pages' })).toBe('10--20');
    expect(toBibtexValue('100 \u2014 125', { field: 'pages' })).toBe(
      '100--125',
    );
    expect(
      toBibtexValue('Phân tích cấu trúc tâm lý học', { field: 'title' }),
    ).toBe('Phân tích cấu trúc tâm lý học');
  });

  it('sanitizes Vietnamese đ/Đ to d and strips spaces instead of turning spaces into d', () => {
    expect(sanitizeCitationKey('Nguyễn Đình Tâm 2024')).toBe(
      'NguyenDinhTam2024'.replace('D', 'd'),
    );
    expect(sanitizeCitationKey('John Smith 2024')).toBe('JohnSmith2024');
    expect(sanitizeCitationKey('đặng_2025')).toBe('dang_2025');
  });

  it('escapes contributor names exactly once (no double escaping on & or _)', () => {
    const entry = buildBibEntryFromInput({
      key: 'who2025',
      type: 'journalArticle',
      title: 'Global R&D in AI Systems',
      contributors: [
        { lastName: 'Smith & Co', firstName: 'Jane' },
        { lastName: 'World Health & Relief Org', fieldMode: 1 },
      ],
      year: 2025,
      pages: '12\u201334',
    });

    const bib = entry.toBibtexString();
    expect(bib).toContain('@article{who2025,');
    expect(bib).toContain(
      '  author = {Smith \\& Co, Jane and {World Health \\& Relief Org}},',
    );
    expect(bib).not.toContain('textbackslash');
    expect(bib).toContain('  pages = {12--34}');
    expect(bib).not.toMatch(/,\n\}$/);
  });

  it('normalizes Zotero/CrossRef item types to standard BibTeX entry types', () => {
    expect(
      buildBibEntryFromInput({ key: 'a', itemType: 'journalArticle' })
        .entryType,
    ).toBe('article');
    expect(
      buildBibEntryFromInput({ key: 'b', itemType: 'bookSection' }).entryType,
    ).toBe('incollection');
    expect(
      buildBibEntryFromInput({ key: 'c', itemType: 'conferencePaper' })
        .entryType,
    ).toBe('inproceedings');
    expect(
      buildBibEntryFromInput({ key: 'd', itemType: 'mastersthesis' }).entryType,
    ).toBe('mastersthesis');
    expect(
      buildBibEntryFromInput({ key: 'e', itemType: 'webpage' }).entryType,
    ).toBe('misc');
  });

  it('keeps formatBibtexName escaping enabled by default for standalone callers', () => {
    expect(formatBibtexName({ lastName: 'O&B', firstName: 'A_B' })).toBe(
      'O\\&B, A\\_B',
    );
  });
});
