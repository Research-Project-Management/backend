import { CitationIndexService } from '@/modules/pages/citations/services/index.service';
import { BibtexParser } from '@/modules/pages/citations/domain/bibtex.domain';
import {
  BibEntry,
  BibliographyFile,
} from '@/modules/pages/citations/domain/bib-entry.domain';
import type { CitationsRepository } from '@/modules/pages/citations/repositories/citations.repository';
import type { RedisCacheService } from '@/core';

describe('Pages Citations - Index Cache & ConflictPolicy', () => {
  it('serves repeated reads from L1/L2 cache without calling collectBibFiles again', async () => {
    const store = new Map<string, unknown>();
    const mockRedis = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      del: jest.fn(async (k: string) => {
        store.delete(k);
      }),
    } as unknown as RedisCacheService;

    const mockRepo = {
      collectBibFiles: jest.fn(async () => [
        new BibliographyFile({
          path: '/references.bib',
          entries: [
            new BibEntry({
              key: 'vaswani2017',
              entryType: 'inproceedings',
              fields: {
                title: 'Attention Is All You Need',
                author: 'Vaswani, Ashish',
                year: '2017',
              },
            }),
          ],
        }),
      ]),
    } as unknown as CitationsRepository;

    const indexSvc = new CitationIndexService(mockRepo, mockRedis);

    const r1 = await indexSvc.queryCitations('space-1', 'vaswani', 50);
    expect(r1.total).toBe(1);
    expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(1);

    const r2 = await indexSvc.queryCitations('space-1', 'attention', 50);
    expect(r2.total).toBe(1);
    expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(1);

    await indexSvc.invalidateSpace('space-1');
    const r3 = await indexSvc.queryCitations('space-1', '', 50);
    expect(r3.total).toBe(1);
    expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(2);
  });

  it('supports skip and rename conflict policies in upsertEntriesBatch', () => {
    const parser = new BibtexParser();
    const existing = '@article{vaswani2017,\n  title = {Original},\n}';
    const incoming = [
      {
        key: 'vaswani2017',
        bibString: '@article{vaswani2017,\n  title = {New Version},\n}',
      },
    ];

    const skipped = BibtexParser.upsertEntriesBatch(existing, incoming, 'skip');
    expect(skipped.conflicts).toEqual(['vaswani2017']);
    expect(parser.parse(skipped.text)[0].title).toBe('Original');

    const renamed = BibtexParser.upsertEntriesBatch(existing, incoming, 'rename');
    expect(renamed.conflicts).toEqual(['vaswani2017']);
    expect(renamed.renamedKeys).toEqual({ vaswani2017: 'vaswani2017_2' });
    expect(parser.parse(renamed.text).map((e) => e.key.value)).toEqual([
      'vaswani2017',
      'vaswani2017_2',
    ]);
  });

  it('isolates sibling page caches on page-scoped invalidation and sweeps L2 pattern on space-wide invalidation', async () => {
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
              fields: { title: pageId === 'page-b' ? 'BERT' : 'Attention' },
            }),
          ],
        }),
      ]),
    } as unknown as CitationsRepository;

    const indexSvc = new CitationIndexService(mockRepo, mockRedis);

    const pageA = await indexSvc.queryCitations('space-1', '', 50, 'page-a');
    const pageB = await indexSvc.queryCitations('space-1', '', 50, 'page-b');
    expect(pageA.items[0].key).toBe('vaswani2017');
    expect(pageB.items[0].key).toBe('bert2019');
    expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(2);

    // Invalidating page-a preserves page-b in L1/L2
    await indexSvc.invalidateSpace('space-1', 'page-a');
    await indexSvc.queryCitations('space-1', '', 50, 'page-b');
    expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(2);

    // Space-wide invalidation sweeps L2 pattern across all pages
    await indexSvc.invalidateSpace('space-1');
    expect(delPattern).toHaveBeenCalledWith('citation:index:v1:space-1:*');
  });
});
