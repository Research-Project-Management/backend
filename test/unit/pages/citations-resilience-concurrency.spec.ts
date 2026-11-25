import { ResilientIdentifierResolver } from '@/modules/pages/citations/services/resolver.service';
import { IdentifierVo } from '@/modules/pages/citations/domain/value-objects.domain';
import { BibEntry } from '@/modules/pages/citations/domain/bib-entry.domain';
import { IIdentifierResolverPort } from '@/modules/pages/citations/domain/citations.ports';
import { CitationsRepository } from '@/modules/pages/citations/repositories/citations.repository';
import type { RedisCacheService, DistributedLockService } from '@/core';

describe('Pages Citations - Sprint 2 Resilience & Concurrency', () => {
  describe('ResilientIdentifierResolver', () => {
    it('coalesces concurrent identical requests via singleflight', async () => {
      let calls = 0;
      const inner: IIdentifierResolverPort = {
        resolve: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 30));
          return new BibEntry({
            key: 'vaswani2017attention',
            entryType: 'inproceedings',
            fields: { title: 'Attention Is All You Need', year: '2017' },
          });
        },
      };

      const resolver = new ResilientIdentifierResolver(inner);
      const id = IdentifierVo.parse('10.48550/arXiv.1706.03762');

      const results = await Promise.all(
        Array.from({ length: 10 }, () => resolver.resolve(id)),
      );

      expect(calls).toBe(1);
      expect(results.every((r) => r?.key.value === 'vaswani2017attention')).toBe(
        true,
      );
    });

    it('uses Redis cache for positive hits and negative misses', async () => {
      const store = new Map<string, unknown>();
      const mockCache = {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
      } as unknown as RedisCacheService;

      const inner: IIdentifierResolverPort = {
        resolve: jest
          .fn()
          .mockResolvedValueOnce(
            new BibEntry({
              key: 'hit2025',
              entryType: 'article',
              fields: { title: 'Cached Paper' },
            }),
          )
          .mockResolvedValueOnce(null),
      };

      const resolver = new ResilientIdentifierResolver(inner, mockCache);

      // Positive cache test
      const doi = IdentifierVo.parse('10.1000/test-hit');
      const first = await resolver.resolve(doi);
      const second = await resolver.resolve(doi);
      expect(first?.key.value).toBe('hit2025');
      expect(second?.key.value).toBe('hit2025');
      expect(inner.resolve).toHaveBeenCalledTimes(1);

      // Negative cache test
      const missing = IdentifierVo.parse('10.1000/test-miss');
      expect(await resolver.resolve(missing)).toBeNull();
      expect(await resolver.resolve(missing)).toBeNull();
      expect(inner.resolve).toHaveBeenCalledTimes(2);
    });

    it('isolates failures per provider with CircuitBreaker', async () => {
      const inner: IIdentifierResolverPort = {
        resolve: jest.fn(async (id: IdentifierVo) => {
          if (id.isArxiv()) {
            throw new Error('arXiv 503 Service Unavailable');
          }
          return new BibEntry({
            key: 'doi2025',
            entryType: 'article',
            fields: { title: 'Healthy DOI' },
          });
        }),
      };

      const resolver = new ResilientIdentifierResolver(inner);
      const arxivId = IdentifierVo.parse('1706.03762');
      const doiId = IdentifierVo.parse('10.1000/healthy');

      // Trip arxiv circuit breaker (5 failures)
      for (let i = 0; i < 6; i++) {
        expect(await resolver.resolve(arxivId)).toBeNull();
      }
      // 6th call should have fast-failed without invoking inner
      expect(inner.resolve).toHaveBeenCalledTimes(5);

      // DOI provider must remain unaffected
      const doiRes = await resolver.resolve(doiId);
      expect(doiRes?.key.value).toBe('doi2025');
    });
  });

  describe('CitationsRepository - Per-Doc Lock & OCC Retry', () => {
    it('retries on 409 revision conflict inside distributed lock and succeeds', async () => {
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
            const err = new Error('Revision conflict on expectedRev') as Error & {
              status: number;
            };
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

      expect(mockLock.withLock).toHaveBeenCalledTimes(1);
      expect(mockDocstore.updateDoc).toHaveBeenCalledTimes(2);
      expect(res.docId).toBe('doc-1');
    });
  });
});
