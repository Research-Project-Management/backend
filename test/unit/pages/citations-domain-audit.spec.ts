import { BibtexParser } from '@/modules/pages/citations/domain/bibtex-parser.domain';
import { AuthorListVo } from '@/modules/pages/citations/domain/author-list.domain';
import { CitationKeyVo } from '@/modules/pages/citations/domain/citation-key.domain';
import { BibEntry } from '@/modules/pages/citations/domain/bib-entry.domain';

describe('Pages Citations Domain - Algorithm & Correctness Audit Fixes', () => {
  const parser = new BibtexParser();

  describe('BibtexParser comment scanner (state machine)', () => {
    it('preserves % inside braced URLs and abstracts while stripping top-level comments', () => {
      const bib = `
% Top-level comment with @article{fake, title={Fake}}
@article{vaswani2017,
  title = {Attention Is All You Need},
  url = {https://example.com/paper%20v1%20final.pdf},
  abstract = {Accuracy improved by 20% on WMT14},
  year = {2017}
}

@inproceedings{devlin2019,
  title = {BERT},
  year = {2019}
}
`;
      const entries = parser.parse(bib);
      expect(entries).toHaveLength(2);
      expect(entries[0].key.value).toBe('vaswani2017');
      expect(entries[0].getFieldValue('url')).toBe(
        'https://example.com/paper%20v1%20final.pdf',
      );
      expect(entries[0].getFieldValue('abstract')).toBe(
        'Accuracy improved by 20% on WMT14',
      );
      expect(entries[1].key.value).toBe('devlin2019');
    });
  });

  describe('BibtexParser.upsertEntriesBatch (O(N+M) single-pass patcher)', () => {
    it('updates both {..} and (..) entries, reports conflicts, and appends new entries', () => {
      const initial = `% Header comment
@article(parenKey,
  title = {Old Paren Title},
  year = {2020}
)

@article{braceKey,
  title = {Old Brace Title},
  url = {https://example.com/a%20b},
  year = {2021}
}
`;
      const { text, conflicts } = BibtexParser.upsertEntriesBatch(initial, [
        {
          key: 'parenKey',
          bibString: '@article{parenKey,\n  title = {New Paren Title},\n  year = {2025},\n}',
        },
        {
          key: 'newKey',
          bibString: '@article{newKey,\n  title = {Brand New},\n  year = {2026},\n}',
        },
      ]);

      expect(conflicts).toEqual(['parenKey']);
      const parsed = parser.parse(text);
      expect(parsed.map((e) => e.key.value)).toEqual([
        'parenKey',
        'braceKey',
        'newKey',
      ]);
      expect(parsed[0].title).toBe('New Paren Title');
      expect(parsed[1].getFieldValue('url')).toBe('https://example.com/a%20b');
      expect(parsed[2].title).toBe('Brand New');
    });

    it('handles large batch upserts (500 entries into 500 existing) in linear time', () => {
      const existingEntries = Array.from({ length: 500 }, (_, i) =>
        `@article{key_${i},\n  title = {Paper ${i}},\n  year = {2024},\n}`,
      ).join('\n\n');

      const incoming = Array.from({ length: 500 }, (_, i) => ({
        key: i < 250 ? `key_${i}` : `new_key_${i}`,
        bibString: `@article{${i < 250 ? `key_${i}` : `new_key_${i}`},\n  title = {Updated ${i}},\n  year = {2026},\n}`,
      }));

      const t0 = Date.now();
      const { text, conflicts } = BibtexParser.upsertEntriesBatch(
        existingEntries,
        incoming,
      );
      const elapsedMs = Date.now() - t0;

      expect(conflicts).toHaveLength(250);
      expect(elapsedMs).toBeLessThan(1000);
      const parsed = parser.parse(text);
      expect(parsed).toHaveLength(750);
    });
  });

  describe('AuthorListVo.parseAuthors', () => {
    it('does not split corporate names containing "and" inside braces', () => {
      const list = new AuthorListVo(
        '{Research and Development Lab} and Vaswani, Ashish',
      );
      expect(list.authors).toHaveLength(2);
      expect(list.authors[0].fullName).toBe('Research and Development Lab');
      expect(list.authors[1].lastName).toBe('Vaswani');
    });
  });

  describe('CitationKeyVo', () => {
    it('rejects backslash in citation keys and sanitizes Vietnamese characters', () => {
      expect(() => CitationKeyVo.create('bad\\key')).toThrow();
      expect(CitationKeyVo.sanitize('Đặng Văn A 2026')).toBe('Dang_Van_A_2026');
    });
  });

  describe('BibEntry', () => {
    it('lazily generates id and rawBibtex and formats toJSON cleanly', () => {
      const entry = new BibEntry({
        key: 'smith2025',
        entryType: 'article',
        fields: {
          title: '{Deep Learning}',
          author: 'Smith, Jane',
          journal: '{Nature}',
          year: '2025',
        },
      });
      const json = entry.toJSON('refs.bib');
      expect(json.journal).toBe('Nature');
      expect(json.title).toBe('Deep Learning');
      expect(entry.id).toMatch(/^entry-/);
      expect(entry.rawBibtex).toContain('@article{smith2025,');
    });
  });
});
