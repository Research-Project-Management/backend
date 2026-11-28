import { Injectable } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { PageDoc, Prisma } from '@prisma/client';

@Injectable()
export class ScopeRepository {
  constructor(private readonly prisma: PrismaService) {}

  public getPrisma(): PrismaService {
    return this.prisma;
  }

  /**
   * Resolves a document within a project either by its UUID or by relative file path.
   * Scoped strictly by projectId to eliminate cross-tenant IDOR / path traversal.
   */
  async findDocInProject(
    projectId: string,
    identifier: string,
  ): Promise<PageDoc | null> {
    if (!projectId || !identifier) return null;

    if (isUuid(identifier)) {
      const idOrNodeFilter: Prisma.PageDocWhereInput[] = [
        { id: identifier },
        { node: { id: identifier } },
      ];
      const doc = await this.prisma.pageDoc.findFirst({
        where: {
          spaceId: projectId,
          deletedAt: null,
          OR: idOrNodeFilter,
        },
      });
      if (doc) return doc;

      const byPageScope = await this.prisma.pageDoc
        .findFirst({
          where: {
            pageId: projectId,
            deletedAt: null,
            OR: idOrNodeFilter,
          },
        })
        .catch(() => null);
      if (byPageScope) return byPageScope;
    }

    const normalizedPath = identifier.startsWith('/')
      ? identifier.slice(1)
      : identifier;
    const pathCandidates: Prisma.PageDocWhereInput[] = [
      { node: { path: `/${normalizedPath}` } },
      { lastKnownPath: identifier },
      { lastKnownPath: normalizedPath },
      { lastKnownPath: `/${normalizedPath}` },
    ];

    const byProjectPath = await this.prisma.pageDoc.findFirst({
      where: {
        spaceId: projectId,
        deletedAt: null,
        OR: pathCandidates,
      },
    });
    if (byProjectPath) return byProjectPath;

    return this.prisma.pageDoc
      .findFirst({
        where: {
          pageId: projectId,
          deletedAt: null,
          OR: pathCandidates,
        },
      })
      .catch(() => null);
  }
}
