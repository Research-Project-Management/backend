import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import {
  PageCommentThread,
  PageCommentReply,
  PageTrackChange,
  Prisma,
} from '@prisma/client';

@Injectable()
export class ReviewScopeRepository {
  private readonly logger = new Logger(ReviewScopeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  public getPrisma(): PrismaService {
    return this.prisma;
  }

  /**
   * Updates a comment reply conditioned strictly on threadId.
   */
  async updateReplyInThread(
    threadId: string,
    replyId: string,
    content: string,
  ): Promise<boolean> {
    if (!isUUID(threadId) || !isUUID(replyId)) return false;
    const result = await this.prisma.pageCommentReply.updateMany({
      where: { id: replyId, threadId },
      data: { content: content.trim(), updatedAt: new Date() },
    });
    return result.count > 0;
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
   * Finds a comment thread conditioned on projectId and optionally docId.
   */
  async findThreadInProject(
    projectId: string,
    threadId: string,
    docId?: string,
  ): Promise<(PageCommentThread & { replies: PageCommentReply[] }) | null> {
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
   * Atomically claims pending track changes for accept/reject resolution inside a transaction
   * to prevent double-patch TOCTOU races across concurrent requests.
   */
  async claimTrackChangesPending(
    projectId: string,
    changeIds: string[],
    nextStatus: 'accepted' | 'rejected',
    resolvedById: string | null,
    docId?: string,
  ): Promise<string[]> {
    const uniqueIds = Array.from(new Set(changeIds.filter((id) => isUUID(id))));
    if (uniqueIds.length === 0) return [];
    const resolvedAt = new Date();

    const runClaim = async (db: Pick<PrismaService, 'pageTrackChange'>) => {
      const claimed: string[] = [];
      for (const id of uniqueIds) {
        const res = await db.pageTrackChange.updateMany({
          where: {
            id,
            spaceId: projectId,
            status: 'pending',
            ...(docId && isUUID(docId) ? { docId } : {}),
          },
          data: {
            status: nextStatus,
            resolvedAt,
            resolvedById,
            updatedAt: resolvedAt,
          },
        });
        if (res.count === 1) {
          claimed.push(id);
        }
      }
      return claimed;
    };

    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(async (tx) => {
        const client = tx?.pageTrackChange ? tx : this.prisma;
        return runClaim(client);
      });
    }
    return runClaim(this.prisma);
  }

  /**
   * Reverts claimed track changes back to pending if Docstore patch fails or conflicts.
   */
  async revertClaimedTrackChanges(
    projectId: string,
    changeIds: string[],
    expectedStatus: 'accepted' | 'rejected',
  ): Promise<void> {
    if (changeIds.length === 0) return;
    await this.prisma.pageTrackChange.updateMany({
      where: {
        id: { in: changeIds },
        spaceId: projectId,
        status: expectedStatus,
      },
      data: {
        status: 'pending',
        resolvedAt: null,
        resolvedById: null,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Fetches all documents, structure nodes, comment threads, and track changes
   * for a project in parallel to power the project-wide review overview.
   */
  async getProjectReviewOverviewData(
    projectId: string,
    explicitPageId?: string,
  ) {
    let targetProjectId = projectId;
    let targetPageId: string | undefined =
      explicitPageId && isUUID(explicitPageId) ? explicitPageId : undefined;
    if (this.prisma.page?.findUnique) {
      const page = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: projectId },
          select: { id: true, spaceId: true },
        }),
      ).catch(() => null);
      const resolvedSpaceId =
        page?.spaceId ?? (page as { projectId?: string } | null)?.projectId;
      if (resolvedSpaceId) {
        targetProjectId = resolvedSpaceId;
        if (!targetPageId && page?.id) {
          targetPageId = page.id;
        }
      }
    }

    const pageFilter = targetPageId ? { pageId: targetPageId } : {};

    const [docs, nodes, allThreads, allChanges] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: { spaceId: targetProjectId, ...pageFilter, deletedAt: null },
        select: { id: true, lastKnownPath: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.pageNode.findMany({
        where: { spaceId: targetProjectId, ...pageFilter, type: 'DOC' },
        select: {
          id: true,
          docId: true,
          name: true,
          path: true,
          sortOrder: true,
          page: { select: { rootDocId: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.pageCommentThread.findMany({
        where: { spaceId: targetProjectId, ...pageFilter },
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ startLine: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.pageTrackChange.findMany({
        where: { spaceId: targetProjectId, ...pageFilter },
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
