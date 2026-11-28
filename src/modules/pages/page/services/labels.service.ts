/**
 * modules/pages/page/services/labels.service.ts
 * Domain service resolving space labels and managing 3NF page_labels assignments.
 */

import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { getRecordSpaceId } from '@/modules/pages/core';
import { ScopeRepository } from '@/modules/pages/docstore';
import { PageRepository, type ResolvedSpaceLabel } from '../page.repository';

export async function resolveProjectLabels(
  prismaOrRepo: PrismaService | PageRepository,
  spaceId: string,
  labelIds: string[],
): Promise<ResolvedSpaceLabel[]> {
  if (!labelIds || labelIds.length === 0) return [];
  const repo =
    prismaOrRepo instanceof PageRepository
      ? prismaOrRepo
      : new PageRepository(prismaOrRepo);
  return repo.findSpaceLabelsByIds(spaceId, labelIds);
}

@Injectable()
export class PageLabelsService {
  private readonly pageRepo: PageRepository;
  private readonly pageScopeRepo: ScopeRepository;

  constructor(
    prisma: PrismaService,
    @Optional() pageRepo?: PageRepository,
    @Optional() pageScopeRepo?: ScopeRepository,
  ) {
    this.pageRepo = pageRepo ?? new PageRepository(prisma);
    this.pageScopeRepo = pageScopeRepo ?? new ScopeRepository(prisma);
  }

  private async resolveTargetPage(
    spaceId: string,
    pageId: string,
    requireExistence: boolean,
  ): Promise<{ canonicalPageId: string; targetSpaceId: string } | null> {
    const ownedPage = await this.pageRepo.findActivePageInSpace(spaceId, pageId);
    if (ownedPage) {
      return {
        canonicalPageId: ownedPage.id,
        targetSpaceId: ownedPage.spaceId || spaceId,
      };
    }

    const doc = await this.pageScopeRepo.findDocInProject(spaceId, pageId);
    if (!doc) {
      if (requireExistence) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Page ${pageId} not found`,
        });
      }
      return null;
    }

    return {
      canonicalPageId: doc.pageId || (requireExistence ? pageId : ''),
      targetSpaceId: getRecordSpaceId(doc) || spaceId,
    };
  }

  public async getPageLabels(
    spaceId: string,
    pageId: string,
  ): Promise<{ labels: ResolvedSpaceLabel[] }> {
    if (!isUuid(pageId)) {
      return { labels: [] };
    }
    const target = await this.resolveTargetPage(spaceId, pageId, false);
    if (!target?.canonicalPageId) {
      return { labels: [] };
    }
    const labels = await this.pageRepo.findPageLabels(target.canonicalPageId);
    return { labels };
  }

  public async assignPageLabels(
    spaceId: string,
    pageId: string,
    labelIds?: string[],
  ): Promise<{ labels: ResolvedSpaceLabel[] }> {
    if (!isUuid(pageId) || !Array.isArray(labelIds)) {
      return { labels: [] };
    }
    const target = await this.resolveTargetPage(spaceId, pageId, true);
    const labels = await resolveProjectLabels(
      this.pageRepo,
      target!.targetSpaceId,
      labelIds,
    );
    await this.pageRepo.replacePageLabels(
      target!.canonicalPageId,
      labels.map((l) => l.id),
    );
    return { labels };
  }

  public async removePageLabel(
    spaceId: string,
    pageId: string,
    labelId: string,
  ): Promise<{ labels: ResolvedSpaceLabel[] }> {
    if (!isUuid(pageId)) {
      return { labels: [] };
    }
    const target = await this.resolveTargetPage(spaceId, pageId, true);
    await this.pageRepo.removePageLabel(target!.canonicalPageId, labelId);
    const labels = await this.pageRepo.findPageLabels(target!.canonicalPageId);
    return { labels };
  }
}
