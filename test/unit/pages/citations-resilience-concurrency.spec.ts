import { BibEntry } from '@/modules/pages/citations/domain/bib-entry.domain';
import { CitationsRepository } from '@/modules/pages/citations/repositories/citations.repository';
import type { DistributedLockService } from '@/core';

describe('Pages Citations - Concurrency (Per-Doc Lock & OCC Retry)', () => {
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
