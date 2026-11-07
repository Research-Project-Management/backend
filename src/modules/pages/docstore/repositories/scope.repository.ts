import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import {
  PageDoc,
  PageCommentThread,
  PageCommentReply,
  PageTrackChange,
  PageSnapshot,
  PageSnapshotLabel,
  PageFile,
  Prisma,
} from '@prisma/client';

@Injectable()
export class ScopeRepository {
  private readonly logger = new Logger(ScopeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  public getPrisma(): PrismaService {
    return this.prisma;
  }

  /**
   * Deletes a comment reply conditioned strictly on threadId.
   */
  async deleteReplyInThread(
    threadId: string,
    replyId: string,
  ): Promise<boolean> {
    if (!isUUID(threadId) || !isUUID(replyId)) return false;
    const result = await this.prisma.pageCommentReply.deleteMany({
      where: { id: replyId, threadId },
    });
    return result.count > 0;
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
          { path: identifier },
          { path: normalizedPath },
          { path: `/${normalizedPath}` },
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
            { path: identifier },
            { path: normalizedPath },
            { path: `/${normalizedPath}` },
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
   * Finds a comment thread conditioned on projectId and optionally docId.
   */
  async findThreadInProject(
    projectId: string,
    threadId: string,
    docId?: string,
  ): Promise<
    (PageCommentThread & { replies: PageCommentReply[] }) | null
  > {
    if (!isUUID(threadId)) return null;

    return this.prisma.pageCommentThread.findFirst({
      where: {
        id: threadId,
        spaceId: projectId,
        ...(docId && isUUID(docId) ? { docId } : {}),
      },
      include: {
        replies: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * Updates a comment thread conditioned on projectId.
   */
  async updateThreadInProject(
    projectId: string,
    threadId: string,
    data: Prisma.PageCommentThreadUpdateInput,
  ): Promise<boolean> {
    const result = await this.prisma.pageCommentThread.updateMany({
      where: { id: threadId, spaceId: projectId },
      data,
    });
    return result.count > 0;
  }

  /**
   * Deletes a comment thread conditioned on projectId.
   */
  async deleteThreadInProject(
    projectId: string,
    threadId: string,
  ): Promise<boolean> {
    const result = await this.prisma.pageCommentThread.deleteMany({
      where: { id: threadId, spaceId: projectId },
    });
    return result.count > 0;
  }

  /**
   * Finds a track change conditioned on projectId and optionally docId.
   */
  async findTrackChangeInProject(
    projectId: string,
    changeId: string,
    docId?: string,
  ): Promise<PageTrackChange | null> {
    if (!isUUID(changeId)) return null;

    return this.prisma.pageTrackChange.findFirst({
      where: {
        id: changeId,
        spaceId: projectId,
        ...(docId && isUUID(docId) ? { docId } : {}),
      },
    });
  }

  /**
   * Updates a track change conditioned on projectId.
   */
  async updateTrackChangeInProject(
    projectId: string,
    changeId: string,
    data: Prisma.PageTrackChangeUpdateInput,
  ): Promise<boolean> {
    const result = await this.prisma.pageTrackChange.updateMany({
      where: { id: changeId, spaceId: projectId },
      data,
    });
    return result.count > 0;
  }

  /**
   * Finds a snapshot version conditioned strictly on projectId.
   */
  async findSnapshotInProject(
    projectId: string,
    versionOrId: string | number,
  ): Promise<(PageSnapshot & { labels?: PageSnapshotLabel[] }) | null> {
    if (typeof versionOrId === 'number' || !isNaN(Number(versionOrId))) {
      const snap = await this.prisma.pageSnapshot.findFirst({
        where: { spaceId: projectId, version: Number(versionOrId) },
        include: { labels: true },
      });
      if (snap) return snap;
      return this.prisma.pageSnapshot
        .findFirst({
          where: { pageId: projectId, version: Number(versionOrId) },
          include: { labels: true },
        })
        .catch(() => null);
    }

    if (isUUID(String(versionOrId))) {
      const snap = await this.prisma.pageSnapshot.findFirst({
        where: { id: String(versionOrId), spaceId: projectId },
        include: { labels: true },
      });
      if (snap) return snap;
      return this.prisma.pageSnapshot
        .findFirst({
          where: { id: String(versionOrId), pageId: projectId },
          include: { labels: true },
        })
        .catch(() => null);
    }

    return null;
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

  /**
   * Fetches all documents, structure nodes, comment threads, and track changes
   * for a project in parallel to power the project-wide review overview.
   */
  async getProjectReviewOverviewData(projectId: string) {
    let targetProjectId = projectId;
    if (this.prisma.page?.findUnique) {
      const page = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: projectId },
          select: { spaceId: true },
        }),
      ).catch(() => null);
      const resolvedSpaceId =
        page?.spaceId ?? (page as { projectId?: string } | null)?.projectId;
      if (resolvedSpaceId) {
        targetProjectId = resolvedSpaceId;
      }
    }

    const [docs, nodes, allThreads, allChanges] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: { spaceId: targetProjectId, deletedAt: null },
        select: { id: true, path: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.pageNode.findMany({
        where: { spaceId: targetProjectId, type: 'DOC' },
        select: {
          id: true,
          docId: true,
          name: true,
          path: true,
          isRootDoc: true,
          sortOrder: true,
        },
        orderBy: [{ isRootDoc: 'desc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.pageCommentThread.findMany({
        where: { spaceId: targetProjectId },
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ startLine: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.pageTrackChange.findMany({
        where: { spaceId: targetProjectId },
        orderBy: [
          { startLine: 'asc' },
          { startCol: 'asc' },
          { createdAt: 'asc' },
        ],
      }),
    ]);

    return { docs, nodes, allThreads, allChanges };
  }
}

/** @deprecated Use ScopeRepository */
export { ScopeRepository as ManuscriptPageScopeRepository };
