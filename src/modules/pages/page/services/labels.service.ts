/**
 * modules/pages/page/services/labels.service.ts
 * Business: Resolving project labels and assigning labels to page documents.
 */

import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { getRecordSpaceId } from '../../core/utils/page-scope';
import { PageRepository, type ResolvedSpaceLabel } from '../page.repository';

export async function resolveProjectLabels(
  prismaOrRepo: PrismaService | PageRepository,
  projectId: string,
  labelIds: string[],
): Promise<ResolvedSpaceLabel[]> {
  if (!labelIds || labelIds.length === 0) return [];
  const repo =
    prismaOrRepo instanceof PageRepository
      ? prismaOrRepo
      : new PageRepository(prismaOrRepo);
  return repo.findSpaceLabelsByIds(projectId, labelIds);
}

export async function resolveAndAssignLabelsForDoc(
  prismaOrRepo: PrismaService | PageRepository,
  pageScopeRepo: ScopeRepository,
  projectId: string,
  pageId: string,
  labelIds: string[],
) {
  const doc = await pageScopeRepo.findDocInProject(projectId, pageId);
  if (!doc) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Document ${pageId} not found`,
    });
  }

  const repo =
    prismaOrRepo instanceof PageRepository
      ? prismaOrRepo
      : new PageRepository(prismaOrRepo);

  const targetProjectId = getRecordSpaceId(doc) || projectId;
  const labels = await resolveProjectLabels(repo, targetProjectId, labelIds);

  // Persist to 3NF page_labels join table (source of truth)
  const canonicalPageId = doc.pageId || pageId;
  await repo.replacePageLabels(
    canonicalPageId,
    labels.map((l) => l.id),
  );

  return { labels };
}
