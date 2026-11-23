import { ReviewRepository } from '@/modules/pages/review/review.repository';
import type { PrismaService } from '@/core';

describe('ReviewRepository.listThreadsPaginated (Keyset Pagination)', () => {
  const spaceId = '11111111-1111-4111-8111-111111111111';
  const docId = '22222222-2222-4222-8222-222222222222';
  const cursorId = '33333333-3333-4333-8333-333333333333';

  function makeRow(id: string, createdAt: Date) {
    return {
      id,
      docId,
      isResolved: true,
      resolvedById: null,
      resolvedAt: createdAt,
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 10,
      anchorStart: null,
      anchorEnd: null,
      baseDocRev: 1,
      createdById: '44444444-4444-4444-8444-444444444444',
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      doc: { spaceId, pageId: docId },
      replies: [],
    };
  }

  it('uses take = limit + 1 and returns hasMore=true with nextCursor when extra row exists', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        makeRow(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          new Date('2026-11-23T10:00:00Z'),
        ),
        makeRow(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          new Date('2026-11-23T09:00:00Z'),
        ),
        makeRow(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          new Date('2026-11-23T08:00:00Z'),
        ),
      ]);
    const prisma = { docComment: { findMany } } as unknown as PrismaService;
    const repo = new ReviewRepository(prisma);

    const page = await repo.listThreadsPaginated(spaceId, docId, {
      isResolved: true,
      limit: 2,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
  });

  it('returns hasMore=false and nextCursor=null on final page', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        makeRow(
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          new Date('2026-11-23T07:00:00Z'),
        ),
      ]);
    const prisma = { docComment: { findMany } } as unknown as PrismaService;
    const repo = new ReviewRepository(prisma);

    const page = await repo.listThreadsPaginated(spaceId, docId, {
      isResolved: true,
      cursor: cursorId,
      limit: 20,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: cursorId },
        skip: 1,
        take: 21,
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('ignores non-UUID cursor and clamps limit to [1, 100]', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { docComment: { findMany } } as unknown as PrismaService;
    const repo = new ReviewRepository(prisma);

    await repo.listThreadsPaginated(spaceId, docId, {
      cursor: 'not-a-uuid',
      limit: 500,
    });

    const callArg = findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.cursor).toBeUndefined();
    expect(callArg.skip).toBeUndefined();
    expect(callArg.take).toBe(101);
  });
});
