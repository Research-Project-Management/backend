/**
 * modules/pages/track-changes/services/review-suggestions.helper.ts
 * Domain payload formatters and batch resolution executor supporting ReviewSuggestionsService.
 */

import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUuid } from '@/core';
import { getRecordSpaceId } from '@/modules/pages/core/page-scope.helper';
import { LiveCollaborationPort } from '@/modules/pages/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { TrackChangesService } from '../track-changes.service';
import { TrackChangesRepository } from '../track-changes.repository';
import {
  TrackChange,
  TextRangeVo,
  LinePatcher,
  StaleTrackChangeAnchorException,
} from '../domain';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import {
  broadcastReviewProjectEvent,
  type ResolvedUserMap,
} from './review.helpers';

export function formatDomainSuggestionItem(
  s: TrackChange,
  userMap: ResolvedUserMap,
) {
  const creator = s.createdById ? userMap.get(s.createdById) : undefined;
  return {
    id: s.id,
    pageId: s.docId,
    page: s.docId,
    projectPageId: s.docId,
    authorId: s.createdById || 'anonymous',
    author: {
      id: s.createdById || 'anonymous',
      name: creator?.name || 'Collaborator',
      avatar: creator?.avatar,
      email: '',
    },
    type: s.type,
    originalText: s.type === 'delete' ? s.text : '',
    suggestedText: s.type === 'insert' ? s.text : '',
    text: s.text,
    fromLine: s.range.startLine + 1,
    fromColumn: s.range.startCol,
    toLine: s.range.endLine + 1,
    toColumn: s.range.endCol,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
    resolvedBy: s.resolvedById ? { id: s.resolvedById } : null,
    resolvedById: s.resolvedById,
  };
}

export async function executeBatchResolveSuggestions(params: {
  targetProjectId: string;
  docId: string;
  isAccept: boolean;
  suggestionIds?: string[];
  userId?: string | null;
  trackChangesRepo?: TrackChangesRepository;
  trackChangesService?: TrackChangesService;
  reviewScopeRepo: ReviewScopeRepository;
  pageScopeRepo: ScopeRepository;
  pageService: PageService;
  docstoreService: DocstoreService;
  liveCollab: LiveCollaborationPort;
  syncLiveDoc: (
    projectId: string,
    docId: string,
    lines: string[],
  ) => Promise<boolean>;
  eventEmitter?: EventEmitter2;
}): Promise<number> {
  const {
    targetProjectId,
    docId,
    isAccept,
    suggestionIds,
    userId,
    trackChangesRepo,
    trackChangesService,
    reviewScopeRepo,
    pageScopeRepo,
    pageService,
    docstoreService,
    liveCollab,
    syncLiveDoc,
    eventEmitter,
  } = params;

  if (!trackChangesRepo) {
    if (trackChangesService) {
      const res = await trackChangesService.batchResolveChanges(
        targetProjectId,
        docId,
        isAccept ? 'accept_all' : 'reject_all',
        suggestionIds,
        userId,
      );
      return res.resolvedCount;
    }
    return 0;
  }

  const pendingChanges = await trackChangesRepo.listChangesByDoc(
    targetProjectId,
    docId,
    'pending',
  );
  const filtered =
    suggestionIds && suggestionIds.length > 0
      ? pendingChanges.filter((c) => suggestionIds.includes(c.id))
      : pendingChanges;
  if (filtered.length === 0) return 0;

  const resolvedStatus = isAccept ? 'accepted' : 'rejected';
  const resolvedById = isUuid(userId) ? userId : null;
  const useAtomicClaim =
    typeof reviewScopeRepo.claimTrackChangesPending === 'function';

  let targetChanges = filtered;
  let claimedIds: string[] = [];
  if (useAtomicClaim) {
    claimedIds = await reviewScopeRepo.claimTrackChangesPending(
      targetProjectId,
      filtered.map((c) => c.id),
      resolvedStatus,
      resolvedById,
      docId,
    );
    if (claimedIds.length === 0) return 0;
    const claimedSet = new Set(claimedIds);
    targetChanges = filtered.filter((c) => claimedSet.has(c.id));
  }

  const normalizedChanges = targetChanges.map((c) =>
    TrackChange.create({
      id: c.id,
      projectId: c.projectId,
      docId: c.docId,
      type: c.type,
      text: c.text,
      range: TextRangeVo.create({
        startLine: Math.max(0, c.range.startLine),
        startCol: Math.max(0, c.range.startCol),
        endLine: Math.max(0, c.range.endLine),
        endCol: Math.max(0, c.range.endCol),
      }),
      createdById: c.createdById,
    }),
  );

  const sorted = LinePatcher.sortChangesBottomUp(normalizedChanges);

  try {
    await liveCollab.flushDocs(targetProjectId, [docId]).catch(() => []);
    const doc = await pageScopeRepo.findDocInProject(targetProjectId, docId);
    if (doc) {
      let currentLines = await pageService.getHydratedDocLines(doc);
      let anyMutated = false;

      for (const change of sorted) {
        const computed = isAccept
          ? LinePatcher.computeAcceptedPatch(currentLines, change)
          : LinePatcher.computeRejectedPatch(currentLines, change);
        currentLines = computed.lines;
        if (computed.mutated) anyMutated = true;
      }

      if (anyMutated) {
        const docProjectId = getRecordSpaceId(doc) || targetProjectId;
        await docstoreService.updateDoc(docProjectId, doc.id, {
          lines: currentLines,
          version: doc.version + 1,
          expectedRev: doc.rev,
        });
        await syncLiveDoc(docProjectId, doc.id, currentLines);
      }
    }

    if (!useAtomicClaim) {
      await trackChangesRepo.batchUpdateChangesStatus(
        sorted.map((c) => c.id),
        resolvedStatus,
        resolvedById,
        new Date(),
        targetProjectId,
        docId,
      );
    }
  } catch (batchErr) {
    if (
      useAtomicClaim &&
      claimedIds.length > 0 &&
      typeof reviewScopeRepo.revertClaimedTrackChanges === 'function'
    ) {
      await reviewScopeRepo
        .revertClaimedTrackChanges(targetProjectId, claimedIds, resolvedStatus)
        .catch(() => undefined);
    }
    if (batchErr instanceof StaleTrackChangeAnchorException) {
      throw new ConflictException({
        statusCode: 409,
        code: batchErr.code,
        message: batchErr.message,
      });
    }
    throw batchErr;
  }

  for (const change of sorted) {
    broadcastReviewProjectEvent(
      eventEmitter,
      targetProjectId,
      'track-changes:resolved',
      { docId, change: change.toJSON(), action: resolvedStatus, resolvedById },
    );
  }

  return sorted.length;
}

export async function applySingleSuggestionDocPatch(params: {
  isAccept: boolean;
  targetProjectId: string;
  suggestionId: string;
  record: {
    id: string;
    docId: string;
    type: string;
    text: string;
    startLine: number | null;
    startCol: number | null;
    endLine: number | null;
    endCol: number | null;
    createdById: string | null;
  };
  nextStatus: 'accepted' | 'rejected';
  resolvedById: string | null;
  liveCollab: LiveCollaborationPort;
  pageScopeRepo: ScopeRepository;
  reviewScopeRepo: ReviewScopeRepository;
  pageService: PageService;
  docstoreService: DocstoreService;
  syncLiveDoc: (
    projectId: string,
    docId: string,
    lines: string[],
  ) => Promise<boolean>;
  eventEmitter?: EventEmitter2;
  logger: { error: (msg: string) => void };
}): Promise<{
  id: string;
  content: string;
  version: number;
  rev: number;
  projectId: string;
} | null> {
  const {
    isAccept,
    targetProjectId,
    suggestionId,
    record,
    nextStatus,
    resolvedById,
    liveCollab,
    pageScopeRepo,
    reviewScopeRepo,
    pageService,
    docstoreService,
    syncLiveDoc,
    eventEmitter,
    logger,
  } = params;

  let updatedPage: {
    id: string;
    content: string;
    version: number;
    rev: number;
    projectId: string;
  } | null = null;
  let broadcastProjectId = targetProjectId;

  try {
    await liveCollab.flushDocs(targetProjectId, [record.docId]).catch(() => []);
    const doc = await pageScopeRepo.findDocInProject(
      targetProjectId,
      record.docId,
    );
    if (doc) {
      const docProjectId = getRecordSpaceId(doc) || targetProjectId;
      broadcastProjectId = docProjectId;
      const lines = await pageService.getHydratedDocLines(doc);
      const changeEntity = TrackChange.create({
        id: record.id,
        projectId: docProjectId,
        docId: doc.id,
        type: record.type === 'delete' ? 'delete' : 'insert',
        text: record.text,
        range: TextRangeVo.create({
          startLine: Math.max(0, record.startLine ?? 0),
          startCol: Math.max(0, record.startCol ?? 0),
          endLine: Math.max(0, record.endLine ?? record.startLine ?? 0),
          endCol: Math.max(0, record.endCol ?? 0),
        }),
        createdById: record.createdById,
      });
      const { lines: nextLines, mutated } = isAccept
        ? LinePatcher.computeAcceptedPatch(lines, changeEntity)
        : LinePatcher.computeRejectedPatch(lines, changeEntity);

      let finalVersion = doc.version;
      let finalRev = doc.rev;
      if (mutated) {
        const updateRes = await docstoreService.updateDoc(
          docProjectId,
          doc.id,
          {
            lines: nextLines,
            version: doc.version + 1,
            expectedRev: doc.rev,
          },
        );
        finalVersion = updateRes?.doc?.version ?? doc.version + 1;
        finalRev = updateRes?.rev ?? updateRes?.doc?.rev ?? doc.rev + 1;
        await syncLiveDoc(docProjectId, doc.id, nextLines);
      }

      updatedPage = {
        id: doc.id,
        content: nextLines.join('\n'),
        version: finalVersion,
        rev: finalRev,
        projectId: docProjectId,
      };
    }
  } catch (err) {
    logger.error(
      `Failed to ${isAccept ? 'apply accepted' : 'revert rejected'} suggestion ${suggestionId} in docstore, rolling back status: ${err}`,
    );
    if (typeof reviewScopeRepo.revertClaimedTrackChanges === 'function') {
      await reviewScopeRepo.revertClaimedTrackChanges(
        targetProjectId,
        [suggestionId],
        nextStatus,
      );
    } else {
      await reviewScopeRepo.updateTrackChangeInProject(
        targetProjectId,
        suggestionId,
        { status: 'pending', resolvedAt: null, resolvedById: null },
      );
    }
    if (err instanceof StaleTrackChangeAnchorException) {
      throw new ConflictException({
        statusCode: 409,
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }

  broadcastReviewProjectEvent(
    eventEmitter,
    broadcastProjectId,
    'track-changes:resolved',
    {
      docId: record.docId,
      change: record,
      action: nextStatus,
      resolvedById,
    },
  );

  return updatedPage;
}
