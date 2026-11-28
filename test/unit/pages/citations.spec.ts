import type { DistributedLockService, RedisCacheService } from '@/core';
import {
  BibEntry,
  BibliographyFile,
  BibtexParser,
  CitationIndexService,
  CitationsService,
  IdentifierNotFoundException,
  buildBibEntryFromInput,
  formatBibtexName,
  sanitizeCitationKey,
  toBibtexValue,
} from '@/modules/pages/citations';
import {
  AuthorListVo,
  CitationKeyVo,
} from '@/modules/pages/citations/domain/value-objects.domain';
import { CitationsRepository } from '@/modules/pages/citations/repositories/citations.repository';

describe('Pages Citations Seam', () => {
  const parser = new BibtexParser();

  describe('BibTeX formatting, mapping & value objects', () => {
    it('normalizes Unicode dashes in page ranges without corrupting Vietnamese diacritics', () => {
      expect(toBibtexValue('10\u201320', { field: 'pages' })).toBe('10--20');
      expect(toBibtexValue('100 \u2014 125', { field: 'pages' })).toBe(
        '100--125',
      );
      expect(
        toBibtexValue('Phân tích cấu trúc tâm lý học', { field: 'title' }),
      ).toBe('Phân tích cấu trúc tâm lý học');
    });

    it('sanitizes citation keys and rejects backslash injection', () => {
      expect(sanitizeCitationKey('Nguyễn Đình Tâm 2024')).toBe(
        'NguyendinhTam2024',
      );
      expect(sanitizeCitationKey('John Smith 2024')).toBe('JohnSmith2024');
      expect(sanitizeCitationKey('đặng_2025')).toBe('dang_2025');
      expect(() => CitationKeyVo.create('bad\\key')).toThrow();
      expect(CitationKeyVo.sanitize('Đặng Văn A 2026')).toBe('Dang_Van_A_2026');
    });

    it('escapes contributor names once, preserves braced corporate names, and normalizes item types', () => {
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

      expect(formatBibtexName({ lastName: 'O&B', firstName: 'A_B' })).toBe(
        'O\\&B, A\\_B',
      );

      const list = new AuthorListVo(
        '{Research and Development Lab} and Vaswani, Ashish',
      );
      expect(list.authors).toHaveLength(2);
      expect(list.authors[0].fullName).toBe('Research and Development Lab');
      expect(list.authors[1].lastName).toBe('Vaswani');

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
        buildBibEntryFromInput({ key: 'd', itemType: 'mastersthesis' })
          .entryType,
      ).toBe('mastersthesis');
      expect(
        buildBibEntryFromInput({ key: 'e', itemType: 'webpage' }).entryType,
      ).toBe('misc');
    });

    it('formats BibEntry JSON cleanly and lazily generates id and rawBibtex', () => {
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

  describe('BibtexParser & batch conflict policies', () => {
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

    it('handles overwrite, skip, and rename conflict policies across {..} and (..) entries', () => {
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
      const overwritten = BibtexParser.upsertEntriesBatch(initial, [
        {
          key: 'parenKey',
          bibString:
            '@article{parenKey,\n  title = {New Paren Title},\n  year = {2025},\n}',
        },
        {
          key: 'newKey',
          bibString:
            '@article{newKey,\n  title = {Brand New},\n  year = {2026},\n}',
        },
      ]);

      expect(overwritten.conflicts).toEqual(['parenKey']);
      const parsed = parser.parse(overwritten.text);
      expect(parsed.map((e) => e.key.value)).toEqual([
        'parenKey',
        'braceKey',
        'newKey',
      ]);
      expect(parsed[0].title).toBe('New Paren Title');
      expect(parsed[1].getFieldValue('url')).toBe('https://example.com/a%20b');
      expect(parsed[2].title).toBe('Brand New');

      const existing = '@article{vaswani2017,\n  title = {Original},\n}';
      const incoming = [
        {
          key: 'vaswani2017',
          bibString: '@article{vaswani2017,\n  title = {New Version},\n}',
        },
      ];

      const skipped = BibtexParser.upsertEntriesBatch(
        existing,
        incoming,
        'skip',
      );
      expect(skipped.conflicts).toEqual(['vaswani2017']);
      expect(parser.parse(skipped.text)[0].title).toBe('Original');

      const renamed = BibtexParser.upsertEntriesBatch(
        existing,
        incoming,
        'rename',
      );
      expect(renamed.conflicts).toEqual(['vaswani2017']);
      expect(renamed.renamedKeys).toEqual({ vaswani2017: 'vaswani2017_2' });
      expect(parser.parse(renamed.text).map((e) => e.key.value)).toEqual([
        'vaswani2017',
        'vaswani2017_2',
      ]);
    });

    it('upserts 500 incoming entries into 500 existing entries in linear time', () => {
      const existingEntries = Array.from(
        { length: 500 },
        (_, i) =>
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
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(conflicts).toHaveLength(250);
      expect(parser.parse(text)).toHaveLength(750);
    });
  });

  describe('Identifier resolution, L1/L2 index cache & OCC concurrency', () => {
    it('resolves DOI via content negotiation with QueryResolver fallback and rejects unknown identifiers', async () => {
      const appendEntriesToBib = jest.fn(async () => ({
        filePath: '/references.bib',
        docId: 'doc-bib',
        conflicts: [],
      }));
      const invalidateSpace = jest.fn(async () => undefined);

      const service = new CitationsService(
        { appendEntriesToBib } as unknown as CitationsRepository,
        parser,
        {
          resolveCitation: jest.fn().mockRejectedValue(new Error('timeout')),
        } as never,
        {
          resolveAcademicQuery: jest.fn().mockResolvedValue({
            found: true,
            work: {
              title: 'Attention Is All You Need',
              authors: ['Ashish Vaswani'],
              year: 2017,
              doi: '10.48550/arXiv.1706.03762',
              type: 'conferencePaper',
            },
          }),
        } as never,
        { invalidateSpace } as unknown as CitationIndexService,
      );

      const resolved = await service.resolveIdentifier(
        'space-1',
        { identifier: 'https://doi.org/10.48550/arXiv.1706.03762' },
        'page-1',
      );
      expect(resolved.docId).toBe('doc-bib');
      expect(resolved.entries[0].title).toBe('Attention Is All You Need');
      expect(invalidateSpace).toHaveBeenCalledWith('space-1', 'page-1');

      await expect(
        service.resolveIdentifier('space-1', { identifier: 'not-an-id' }),
      ).rejects.toThrow(IdentifierNotFoundException);
    });

    it('serves cached reads from L1/L2, isolates sibling pages on page-scoped invalidation, and sweeps pattern on space invalidation', async () => {
      const store = new Map<string, unknown>();
      const delPattern = jest.fn(async (pattern: string) => {
        const prefix = pattern.replace(/\*$/, '');
        for (const k of store.keys()) {
          if (k.startsWith(prefix)) store.delete(k);
        }
      });
      const mockRedis = {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          store.delete(k);
        }),
        delPattern,
      } as unknown as RedisCacheService;

      const mockRepo = {
        collectBibFiles: jest.fn(async (_spaceId: string, pageId?: string) => [
          new BibliographyFile({
            path: '/references.bib',
            entries: [
              new BibEntry({
                key: pageId === 'page-b' ? 'bert2019' : 'vaswani2017',
                entryType: 'article',
                fields: {
                  title:
                    pageId === 'page-b'
                      ? 'BERT'
                      : 'Attention Is All You Need',
                },
              }),
            ],
          }),
        ]),
      } as unknown as CitationsRepository;

      const indexSvc = new CitationIndexService(mockRepo, mockRedis);

      const pageAFirst = await indexSvc.queryCitations(
        'space-1',
        'vaswani',
        50,
        'page-a',
      );
      const pageASecond = await indexSvc.queryCitations(
        'space-1',
        'attention',
        50,
        'page-a',
      );
      const pageB = await indexSvc.queryCitations('space-1', '', 50, 'page-b');

      expect(pageAFirst.total).toBe(1);
      expect(pageASecond.total).toBe(1);
      expect(pageB.items[0].key).toBe('bert2019');
      expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(2);

      // Invalidating page-a preserves page-b in cache
      await indexSvc.invalidateSpace('space-1', 'page-a');
      await indexSvc.queryCitations('space-1', '', 50, 'page-b');
      expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(2);

      // Space-wide invalidation sweeps L2 pattern across all pages
      await indexSvc.invalidateSpace('space-1');
      expect(delPattern).toHaveBeenCalledWith('citation:index:v1:space-1:*');
      await indexSvc.queryCitations('space-1', '', 50, 'page-b');
      expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(3);
    });

    it('retries on 409 revision conflict inside per-doc distributed lock and succeeds', async () => {
      let updateAttempts = 0;
      const mockStructure = {
        getAllNodes: jest.fn(async () => [
          { path: '/references.bib', name: 'references.bib', docId: 'doc-1' },
        ]),
      };
      const mockDocstore = {
        getDoc: jest.fn(async () => ({
          lines: ['@article{existing, title={Old}}'],
          version: 1,
          rev: `rev-${updateAttempts}`,
        })),
        updateDoc: jest.fn(async () => {
          updateAttempts++;
          if (updateAttempts === 1) {
            const err = new Error(
              'Revision conflict on expectedRev',
            ) as Error & { status: number };
            err.status = 409;
            throw err;
          }
          return { ok: true };
        }),
      };
      const mockLock = {
        withLock: jest.fn(
          async (
            _resource: string,
            _ttl: number,
            fn: (h: { heartbeat: () => Promise<boolean> }) => Promise<unknown>,
          ) => fn({ heartbeat: async () => true }),
        ),
      } as unknown as DistributedLockService;

      const repo = new CitationsRepository(
        mockStructure as never,
        mockDocstore as never,
        undefined,
        undefined,
        undefined,
        mockLock,
      );

      const entry = new BibEntry({
        key: 'new2026',
        entryType: 'article',
        fields: { title: 'Concurrent Entry' },
      });

      const res = await repo.appendEntriesToBib('space-1', [entry]);

      expect(res.docId).toBe('doc-1');
      expect(mockDocstore.updateDoc).toHaveBeenCalledTimes(2);
    });
  });
});
