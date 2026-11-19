import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import { PageDoc, PageFile, Prisma } from '@prisma/client';

@Injectable()
export class ScopeRepository {
  private readonly logger = new Logger(ScopeRepository.name);

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

    if (isUUID(identifier)) {
      // 1. Direct docId lookup OR node lookup (if identifier is a nodeId)
      const doc = await this.prisma.pageDoc.findFirst({
        where: {
          spaceId: projectId,
          deletedAt: null,
          OR: [{ id: identifier }, { node: { id: identifier } }],
        },
      });
      if (doc) return doc;

      const byPageScope = await this.prisma.pageDoc
        .findFirst({
          where: {
            pageId: projectId,
            deletedAt: null,
            OR: [{ id: identifier }, { node: { id: identifier } }],
          },
        })
        .catch(() => null);
      if (byPageScope) return byPageScope;
    }

    // Try path lookup scoped strictly to projectId
    const normalizedPath = identifier.startsWith('/')
      ? identifier.slice(1)
      : identifier;

    const byProjectPath = await this.prisma.pageDoc.findFirst({
      where: {
        spaceId: projectId,
        deletedAt: null,
        OR: [
          { node: { path: `/${normalizedPath}` } },
          { lastKnownPath: identifier },
          { lastKnownPath: normalizedPath },
          { lastKnownPath: `/${normalizedPath}` },
        ],
      },
    });
    if (byProjectPath) return byProjectPath;

    return this.prisma.pageDoc
      .findFirst({
        where: {
          pageId: projectId,
          deletedAt: null,
          OR: [
            { node: { path: `/${normalizedPath}` } },
            { lastKnownPath: identifier },
            { lastKnownPath: normalizedPath },
            { lastKnownPath: `/${normalizedPath}` },
          ],
        },
      })
      .catch(() => null);
  }

  /**
   * Ensures a document exists in the project or throws a uniform NotFoundException (no existence oracle).
   */
  async getDocInProjectOrThrow(
    projectId: string,
    identifier: string,
  ): Promise<PageDoc> {
    const doc = await this.findDocInProject(projectId, identifier);
    if (!doc) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found',
      });
    }
    return doc;
  }

  /**
   * Updates document fields conditioned on projectId.
   */
  async updateDocInProject(
    projectId: string,
    docId: string,
    data: Prisma.PageDocUpdateInput,
  ): Promise<boolean> {
    const result = await this.prisma.pageDoc.updateMany({
      where: { id: docId, spaceId: projectId, deletedAt: null },
      data,
    });
    return result.count > 0;
  }

  /**
   * Soft-deletes a document conditioned on projectId.
   */
  async softDeleteDocInProject(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    const result = await this.prisma.pageDoc.updateMany({
      where: { id: docId, spaceId: projectId, deletedAt: null },
      data: {
        deletedAt: new Date(),
      },
    });
    return result.count > 0;
  }

  /**
   * Restores a soft-deleted document conditioned on projectId.
   */
  async restoreDocInProject(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    const result = await this.prisma.pageDoc.updateMany({
      where: { id: docId, spaceId: projectId, deletedAt: { not: null } },
      data: {
        deletedAt: null,
      },
    });
    return result.count > 0;
  }

  /**
   * Finds a manuscript file asset conditioned on projectId.
   */
  async findFileInProject(
    projectId: string,
    fileId: string,
  ): Promise<PageFile | null> {
    if (!isUUID(fileId)) return null;

    const file = await this.prisma.pageFile.findFirst({
      where: { id: fileId, spaceId: projectId, deletedAt: null },
    });
    if (file) return file;
    return this.prisma.pageFile
      .findFirst({
        where: { id: fileId, pageId: projectId, deletedAt: null },
      })
      .catch(() => null);
  }
}
