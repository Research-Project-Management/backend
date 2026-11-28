import { ForbiddenException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService } from '@/core';
import { ProjectResourceResolver } from '@/modules/project/access/resolvers/project-resource.resolver';

describe('ProjectResourceResolver', () => {
  const projectAId = 'a0000000-0000-4000-8000-000000000001';
  const projectBId = 'b0000000-0000-4000-8000-000000000002';
  const pageAId = 'c0000000-0000-4000-8000-000000000003';
  const docBId = 'd0000000-0000-4000-8000-000000000005';

  let resolver: ProjectResourceResolver;
  let mockPageDocFindUnique: jest.Mock;
  let mockProjectFindFirst: jest.Mock;
  let mockLibraryItemFindUnique: jest.Mock;

  beforeEach(() => {
    mockPageDocFindUnique = jest.fn();
    mockProjectFindFirst = jest.fn();
    mockLibraryItemFindUnique = jest.fn();

    resolver = new ProjectResourceResolver(
      fromPartial<PrismaService>({
        pageDoc: { findUnique: mockPageDocFindUnique },
        page: { findUnique: jest.fn() },
        pageNode: { findUnique: jest.fn() },
        pageSnapshot: { findUnique: jest.fn() },
        docComment: { findUnique: jest.fn() },
        pageFile: { findUnique: jest.fn() },
        fileNode: { findUnique: jest.fn() },
        workItem: { findFirst: jest.fn(), findUnique: jest.fn() },
        project: { findUnique: jest.fn(), findFirst: mockProjectFindFirst },
        libraryItem: { findUnique: mockLibraryItemFindUnique },
      }),
    );
  });

  it('resolves authoritative projectId from pageDoc and Library items, and rejects cross-context mismatches', async () => {
    mockPageDocFindUnique.mockResolvedValue({
      id: pageAId,
      spaceId: projectAId,
    });

    const pageReq: Record<string, unknown> = {
      params: { pageId: pageAId },
      headers: {},
      query: {},
      body: {},
    };
    await expect(
      resolver.resolveAuthoritativeProjectId(pageReq),
    ).resolves.toEqual({
      projectId: projectAId,
      spaceId: projectAId,
      isPersonalSpace: false,
      source: 'resource',
    });
    expect(pageReq.resolvedProjectId).toBe(projectAId);
    expect(pageReq.resolvedPageId).toBe(pageAId);

    // Header mismatch -> PROJECT_CONTEXT_MISMATCH
    let caught: unknown;
    try {
      await resolver.resolveAuthoritativeProjectId({
        params: { pageId: pageAId },
        headers: { 'x-project-id': projectBId },
        query: {},
        body: {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({
      code: 'PROJECT_CONTEXT_MISMATCH',
    });

    // Multi-resource cross-project mismatch
    mockPageDocFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        if (where.id === pageAId) return { spaceId: projectAId };
        if (where.id === docBId) return { spaceId: projectBId };
        return null;
      },
    );
    await expect(
      resolver.resolveAuthoritativeProjectId({
        params: { pageId: pageAId },
        body: { docId: docBId },
        headers: {},
        query: {},
      }),
    ).rejects.toThrow(ForbiddenException);

    // Library item dual-context resolution + space mismatch rejection
    mockLibraryItemFindUnique.mockResolvedValue({ spaceId: projectAId });
    await expect(
      resolver.resolveAuthoritativeProjectId({
        url: `/api/v1/library/items/${pageAId}`,
        params: { itemId: pageAId },
        headers: {},
        query: {},
        body: {},
      }),
    ).resolves.toEqual({
      projectId: projectAId,
      spaceId: projectAId,
      isPersonalSpace: false,
      source: 'resource',
    });

    await expect(
      resolver.resolveAuthoritativeProjectId({
        url: `/api/v1/spaces/${projectBId}/library/items/${pageAId}`,
        params: { spaceId: projectBId, itemId: pageAId },
        headers: { 'x-space-id': projectBId },
        query: {},
        body: {},
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('resolves UUID params, human-readable slugs, spaceId hints, and personal space aliases, while failing closed on DB or unknown slug errors', async () => {
    await expect(
      resolver.resolveAuthoritativeProjectId({
        params: { projectId: projectAId },
        headers: {},
        query: {},
        body: {},
      }),
    ).resolves.toEqual({
      projectId: projectAId,
      spaceId: projectAId,
      isPersonalSpace: false,
      source: 'param',
    });

    mockProjectFindFirst.mockResolvedValueOnce({
      id: projectAId,
      identifier: 'my-project',
    });
    await expect(
      resolver.resolveAuthoritativeProjectId({
        params: { projectId: 'my-project' },
        headers: {},
        query: {},
        body: {},
      }),
    ).resolves.toEqual({
      projectId: projectAId,
      spaceId: projectAId,
      isPersonalSpace: false,
      source: 'param',
    });

    // Header vs query conflict
    await expect(
      resolver.resolveAuthoritativeProjectId({
        params: {},
        headers: { 'x-project-id': projectAId },
        query: { projectId: projectBId },
        body: {},
      }),
    ).rejects.toThrow(ForbiddenException);

    // Unknown slug fails closed
    mockProjectFindFirst.mockResolvedValueOnce(null);
    await expect(
      resolver.resolveAuthoritativeProjectId({
        params: {},
        headers: {},
        query: { projectId: 'unknown-slug' },
        body: {},
      }),
    ).rejects.toThrow(ForbiddenException);

    // DB error fails closed
    mockPageDocFindUnique.mockRejectedValueOnce(new Error('DB timeout'));
    await expect(
      resolver.resolveAuthoritativeProjectId({
        params: { pageId: pageAId },
        headers: {},
        query: {},
        body: {},
      }),
    ).rejects.toThrow(ForbiddenException);

    // Hint & personal space resolution
    await expect(
      resolver.resolveAuthoritativeProjectId({
        url: '/api/v1/library/items',
        params: {},
        headers: {},
        query: { spaceId: projectAId },
        body: {},
      }),
    ).resolves.toEqual({
      projectId: projectAId,
      spaceId: projectAId,
      isPersonalSpace: false,
      source: 'hint',
    });

    const personalUserId = 'e0000000-0000-4000-8000-000000000009';
    for (const rawSpace of [personalUserId, 'personal']) {
      await expect(
        resolver.resolveAuthoritativeProjectId({
          url: '/api/v1/pages/compile',
          user: { sub: personalUserId, id: personalUserId },
          params: {},
          headers: {},
          query: {},
          body: { spaceId: rawSpace },
        }),
      ).resolves.toEqual({
        projectId: personalUserId,
        spaceId: personalUserId,
        isPersonalSpace: true,
        source: 'hint',
      });
    }
  });
});
