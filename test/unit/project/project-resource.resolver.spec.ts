import { ForbiddenException } from '@nestjs/common';
import { ProjectResourceResolver } from '@/modules/project/access/resolvers/project-resource.resolver';

describe('ProjectResourceResolver', () => {
  let resolver: ProjectResourceResolver;
  let mockPrisma: any;

  const projectAId = 'a0000000-0000-4000-8000-000000000001';
  const projectBId = 'b0000000-0000-4000-8000-000000000002';
  const pageAId = 'c0000000-0000-4000-8000-000000000003';
  const docAId = 'd0000000-0000-4000-8000-000000000004';
  const docBId = 'd0000000-0000-4000-8000-000000000005';

  beforeEach(() => {
    mockPrisma = {
      manuscriptDoc: {
        findUnique: jest.fn(),
      },
      manuscriptNode: {
        findUnique: jest.fn(),
      },
      manuscriptSnapshot: {
        findUnique: jest.fn(),
      },
      manuscriptCommentThread: {
        findUnique: jest.fn(),
      },
      file: {
        findUnique: jest.fn(),
      },
      workItem: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      project: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    resolver = new ProjectResourceResolver(mockPrisma);
  });

  it('should resolve projectId from pageId resource', async () => {
    mockPrisma.manuscriptDoc.findUnique.mockResolvedValue({
      id: pageAId,
      projectId: projectAId,
    });

    const req = {
      params: { pageId: pageAId },
      headers: {},
      query: {},
      body: {},
    };

    const result = await resolver.resolveAuthoritativeProjectId(req);
    expect(result).toEqual({
      projectId: projectAId,
      source: 'resource',
    });
    expect((req as any).resolvedProjectId).toBe(projectAId);
    expect((req as any).resolvedPageId).toBe(pageAId);
  });

  it('should throw PROJECT_CONTEXT_MISMATCH if client project hint disagrees with resource project', async () => {
    mockPrisma.manuscriptDoc.findUnique.mockResolvedValue({
      id: pageAId,
      projectId: projectAId,
    });

    const req = {
      params: { pageId: pageAId },
      headers: { 'x-project-id': projectBId },
      query: {},
      body: {},
    };

    await expect(resolver.resolveAuthoritativeProjectId(req)).rejects.toThrow(
      ForbiddenException,
    );

    try {
      await resolver.resolveAuthoritativeProjectId(req);
    } catch (err: any) {
      expect(err.getResponse()).toMatchObject({
        code: 'PROJECT_CONTEXT_MISMATCH',
      });
    }
  });

  it('should throw PROJECT_CONTEXT_MISMATCH if multiple referenced resources belong to different projects', async () => {
    mockPrisma.manuscriptDoc.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === pageAId)
        return Promise.resolve({ projectId: projectAId });
      if (where.id === docBId)
        return Promise.resolve({ projectId: projectBId });
      return Promise.resolve(null);
    });

    const req = {
      params: { pageId: pageAId },
      body: { docId: docBId },
      headers: {},
      query: {},
    };

    await expect(resolver.resolveAuthoritativeProjectId(req)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should resolve from path param :projectId when no resource is referenced', async () => {
    const req = {
      params: { projectId: projectAId },
      headers: {},
      query: {},
      body: {},
    };

    const result = await resolver.resolveAuthoritativeProjectId(req);
    expect(result).toEqual({
      projectId: projectAId,
      source: 'param',
    });
  });

  it('should resolve human-readable project identifier to UUID', async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      id: projectAId,
      identifier: 'my-project',
    });

    const req = {
      params: { projectId: 'my-project' },
      headers: {},
      query: {},
      body: {},
    };

    const result = await resolver.resolveAuthoritativeProjectId(req);
    expect(result).toEqual({
      projectId: projectAId,
      source: 'param',
    });
  });

  it('should fail closed on database exception and throw ACCESS_DENIED', async () => {
    mockPrisma.manuscriptDoc.findUnique.mockRejectedValue(
      new Error('DB Connection Timeout'),
    );

    const req = {
      params: { pageId: pageAId },
      headers: {},
      query: {},
      body: {},
    };

    await expect(resolver.resolveAuthoritativeProjectId(req)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should throw PROJECT_CONTEXT_MISMATCH when header x-project-id conflicts with query.projectId', async () => {
    const req = {
      params: {},
      headers: { 'x-project-id': projectAId },
      query: { projectId: projectBId },
      body: {},
    };

    await expect(resolver.resolveAuthoritativeProjectId(req)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should throw ACCESS_DENIED when non-UUID projectId hint does not match any existing project', async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);
    const req = {
      params: {},
      headers: {},
      query: { projectId: 'unknown-slug' },
      body: {},
    };

    await expect(resolver.resolveAuthoritativeProjectId(req)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
