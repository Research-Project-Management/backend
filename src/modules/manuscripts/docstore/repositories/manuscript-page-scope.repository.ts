import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import {
  ManuscriptDoc,
  ManuscriptCommentThread,
  ManuscriptCommentReply,
  ManuscriptTrackChange,
  ManuscriptSnapshot,
  ManuscriptLabel,
  ManuscriptFile,
  Prisma,
} from '@prisma/client';

@Injectable()
export class ManuscriptPageScopeRepository {
  private readonly logger = new Logger(ManuscriptPageScopeRepository.name);

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
    const result = await this.prisma.manuscriptCommentReply.deleteMany({
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
  ): Promise<ManuscriptDoc | null> {
    if (!projectId || !identifier) return null;

    if (isUUID(identifier)) {
      // 1. Direct docId lookup OR node lookup (if identifier is a nodeId)
      const doc = await this.prisma.manuscriptDoc.findFirst({
        where: {
          projectId,
          deleted: false,
          OR: [{ id: identifier }, { node: { id: identifier } }],
        },
      });
      if (doc) return doc;
    }

    // Try path lookup scoped strictly to projectId
    const normalizedPath = identifier.startsWith('/')
      ? identifier.slice(1)
      : identifier;

    return this.prisma.manuscriptDoc.findFirst({
      where: {
        projectId,
        deleted: false,
        OR: [
          { path: identifier },
          { path: normalizedPath },
          { path: `/${normalizedPath}` },
        ],
      },
    });
  }

  /**
   * Ensures a document exists in the project or throws a uniform NotFoundException (no existence oracle).
   */
  async getDocInProjectOrThrow(
    projectId: string,
    identifier: string,
  ): Promise<ManuscriptDoc> {
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
    data: Prisma.ManuscriptDocUpdateInput,
  ): Promise<boolean> {
    const result = await this.prisma.manuscriptDoc.updateMany({
      where: { id: docId, projectId, deleted: false },
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
    const result = await this.prisma.manuscriptDoc.updateMany({
      where: { id: docId, projectId, deleted: false },
      data: {
        deleted: true,
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
    const result = await this.prisma.manuscriptDoc.updateMany({
      where: { id: docId, projectId, deleted: true },
      data: {
        deleted: false,
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
    (ManuscriptCommentThread & { replies: ManuscriptCommentReply[] }) | null
  > {
    if (!isUUID(threadId)) return null;

    return this.prisma.manuscriptCommentThread.findFirst({
      where: {
        id: threadId,
        projectId,
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
    data: Prisma.ManuscriptCommentThreadUpdateInput,
  ): Promise<boolean> {
    const result = await this.prisma.manuscriptCommentThread.updateMany({
      where: { id: threadId, projectId },
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
    const result = await this.prisma.manuscriptCommentThread.deleteMany({
      where: { id: threadId, projectId },
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
  ): Promise<ManuscriptTrackChange | null> {
    if (!isUUID(changeId)) return null;

    return this.prisma.manuscriptTrackChange.findFirst({
      where: {
        id: changeId,
        projectId,
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
    data: Prisma.ManuscriptTrackChangeUpdateInput,
  ): Promise<boolean> {
    const result = await this.prisma.manuscriptTrackChange.updateMany({
      where: { id: changeId, projectId },
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
  ): Promise<(ManuscriptSnapshot & { labels?: ManuscriptLabel[] }) | null> {
    if (typeof versionOrId === 'number' || !isNaN(Number(versionOrId))) {
      return this.prisma.manuscriptSnapshot.findFirst({
        where: { projectId, version: Number(versionOrId) },
        include: { labels: true },
      });
    }

    if (isUUID(String(versionOrId))) {
      return this.prisma.manuscriptSnapshot.findFirst({
        where: { id: String(versionOrId), projectId },
        include: { labels: true },
      });
    }

    return null;
  }

  /**
   * Finds a manuscript file asset conditioned on projectId.
   */
  async findFileInProject(
    projectId: string,
    fileId: string,
  ): Promise<ManuscriptFile | null> {
    if (!isUUID(fileId)) return null;

    return this.prisma.manuscriptFile.findFirst({
      where: { id: fileId, projectId, deleted: false },
    });
  }
}
