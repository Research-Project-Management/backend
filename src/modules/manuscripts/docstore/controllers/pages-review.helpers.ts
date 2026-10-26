/**
 * modules/manuscripts/docstore/controllers/pages-review.helpers.ts
 * Co-located formatting, validation, resolution, and docstore-patching helpers
 * for PagesReviewController.
 */

import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ManuscriptCommentReply,
  ManuscriptCommentThread,
  ManuscriptTrackChange,
} from '@prisma/client';
import { PrismaService, AuthenticatedRequest, isUuid } from '@/core';
import { Role } from '@/modules/project/access';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import {
  applySuggestionToLines,
  applyBatchSuggestionsToLines,
} from '@/modules/manuscripts/track-changes/domain';
import { DocstoreService } from '../docstore.service';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';

export type ResolvedUserMap = Map<
  string,
  { id: string; name: string; avatar?: string }
>;

export type ThreadWithReplies = ManuscriptCommentThread & {
  replies?: ManuscriptCommentReply[];
};

export function resolveActiveProjectId(
  project?: string | { id: string } | null,
): string | undefined {
  if (!project) return undefined;
  return typeof project === 'string' ? project : project.id;
}

export async function resolveDocAndProjectContext(
  prisma: PrismaService,
  pageScopeRepo: ManuscriptPageScopeRepository,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
): Promise<{ docId?: string; projectId?: string }> {
  const activeProjectId = resolveActiveProjectId(authorizedProjectId);
  if (!isUuid(pageId)) {
    return { projectId: activeProjectId };
  }
  const doc = activeProjectId
    ? await pageScopeRepo.findDocInProject(activeProjectId, pageId)
    : await prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { id: true, projectId: true },
      });
  if (doc) {
    return { docId: doc.id, projectId: doc.projectId || activeProjectId };
  }
  const node = await prisma.manuscriptNode.findUnique({
    where: { id: pageId },
    select: { docId: true, projectId: true },
  });
  if (node) {
    return {
      docId: node.docId || pageId,
      projectId: node.projectId || activeProjectId,
    };
  }
  return { docId: pageId, projectId: activeProjectId };
}

export async function resolveCreateTargetContext(
  prisma: PrismaService,
  pageId: string,
  authorizedProjectId: string | { id: string } | null | undefined,
  bodyProjectId: string | undefined,
  req: AuthenticatedRequest | undefined,
  errorMessage: string,
): Promise<{ targetDocId: string; projectId: string }> {
  let projectId: string | null =
    resolveActiveProjectId(authorizedProjectId) || null;
  let targetDocId = pageId;

  if (isUuid(pageId)) {
    const doc = await prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
      select: { projectId: true },
    });
    if (doc?.projectId) {
      projectId = doc.projectId;
    } else {
      const node = await prisma.manuscriptNode.findUnique({
        where: { id: pageId },
        select: { projectId: true, docId: true },
      });
      if (node?.projectId) projectId = node.projectId;
      if (node?.docId) targetDocId = node.docId;
    }
  }

  if (!projectId && bodyProjectId && isUuid(bodyProjectId)) {
    projectId = bodyProjectId;
  }
  const headerProjId = Array.isArray(req?.headers?.['x-project-id'])
    ? req.headers['x-project-id'][0]
    : req?.headers?.['x-project-id'];
  if (!projectId && headerProjId && isUuid(headerProjId)) {
    projectId = headerProjId;
  }

  if (!isUuid(targetDocId) || !projectId) {
    throw new BadRequestException(errorMessage);
  }

  return { targetDocId, projectId };
}

export async function hydrateReviewDocLines(
  docstoreService: DocstoreService,
  doc: {
    id: string;
    projectId: string;
    lines: unknown;
    inStorage?: boolean;
  },
): Promise<string[]> {
  if (doc.inStorage) {
    try {
      const hydrated = await docstoreService.getDoc(doc.projectId, doc.id);
      if (Array.isArray(hydrated.lines)) {
        return hydrated.lines;
      }
    } catch {
      // Fallback to raw lines if hydration fails
    }
  }
  if (Array.isArray(doc.lines)) {
    return (doc.lines as string[]).map((l) => String(l ?? ''));
  }
  if (typeof doc.lines === 'string') {
    return doc.lines.split('\n');
  }
  return [];
}

export function validateCommentRange(
  line?: number,
  lineEnd?: number,
): { startLine: number; endLine: number } {
  const startLine = line ?? 1;
  const endLine = lineEnd ?? startLine;
  if (startLine < 1 || endLine < startLine) {
    throw new BadRequestException(
      'Invalid comment range: startLine must be >= 1 and endLine >= startLine',
    );
  }
  return { startLine, endLine };
}

export function validateSuggestionRange(body: {
  fromLine?: number;
  toLine?: number;
  fromColumn?: number;
  toColumn?: number;
}): {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
} {
  const startLine = body.fromLine ?? 1;
  const endLine = body.toLine ?? startLine;
  const startCol = body.fromColumn ?? 0;
  const endCol = body.toColumn ?? 0;
  if (startLine < 1 || endLine < startLine || startCol < 0 || endCol < 0) {
    throw new BadRequestException(
      'Invalid suggestion range: startLine >= 1, endLine >= startLine, and columns >= 0 are required',
    );
  }
  return { startLine, endLine, startCol, endCol };
}

export function assertCanModifyReviewItem(
  authorId: string | null | undefined,
  userId: string | null | undefined,
  role: Role | undefined,
  message: string,
): void {
  const isAuthor = authorId === userId;
  const isPrivileged = role === Role.COORDINATOR || role === Role.OWNER;
  if (!isAuthor && !isPrivileged) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'ROLE_INSUFFICIENT',
      message,
    });
  }
}

export async function findScopedCommentThreadOrThrow(
  prisma: PrismaService,
  pageScopeRepo: ManuscriptPageScopeRepository,
  commentId: string,
  resolvedDocId?: string,
  targetProjectId?: string,
  includeReplies = false,
): Promise<ThreadWithReplies> {
  const existing = targetProjectId
    ? await pageScopeRepo.findThreadInProject(
        targetProjectId,
        commentId,
        resolvedDocId && isUuid(resolvedDocId) ? resolvedDocId : undefined,
      )
    : await prisma.manuscriptCommentThread.findUnique({
        where: { id: commentId },
        ...(includeReplies ? { include: { replies: true } } : {}),
      });

  if (
    !existing ||
    (resolvedDocId &&
      isUuid(resolvedDocId) &&
      existing.docId &&
      existing.docId !== resolvedDocId) ||
    (targetProjectId &&
      existing.projectId &&
      existing.projectId !== targetProjectId)
  ) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Comment thread ${commentId} not found`,
    });
  }
  return existing;
}

export async function findScopedCommentReplyOrThrow(
  prisma: PrismaService,
  replyId: string,
  commentId: string,
  resolvedDocId?: string,
  targetProjectId?: string,
) {
  const existingReply = await prisma.manuscriptCommentReply.findUnique({
    where: { id: replyId },
    include: {
      thread: {
        select: {
          projectId: true,
          docId: true,
          id: true,
          createdById: true,
        },
      },
    },
  });

  if (
    !existingReply ||
    (existingReply.threadId && existingReply.threadId !== commentId) ||
    (existingReply.thread?.id && existingReply.thread.id !== commentId) ||
    (resolvedDocId &&
      isUuid(resolvedDocId) &&
      existingReply.thread?.docId &&
      existingReply.thread.docId !== resolvedDocId) ||
    (targetProjectId &&
      existingReply.thread?.projectId &&
      existingReply.thread.projectId !== targetProjectId)
  ) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Comment reply ${replyId} not found`,
    });
  }

  return existingReply;
}

export function formatCommentThreadDto(
  t: ThreadWithReplies,
  userMap: ResolvedUserMap,
  options?: { includeAvatar?: boolean; includeDocId?: boolean },
) {
  const threadUser = t.createdById ? userMap.get(t.createdById) : undefined;
  const includeAvatar = options?.includeAvatar ?? false;
  const includeDocId = options?.includeDocId ?? true;

  return {
    id: t.id,
    page: t.docId,
    projectPageId: t.docId,
    ...(includeDocId ? { docId: t.docId } : {}),
    author: {
      id: t.createdById || 'anonymous',
      name: threadUser?.name || 'Collaborator',
      ...(includeAvatar ? { avatar: threadUser?.avatar || '' } : {}),
    },
    content: t.quote || '',
    line: t.startLine,
    lineEnd: t.endLine,
    status: t.isResolved ? 'resolved' : 'open',
    replies: (t.replies || []).map((r) => {
      const replyUser = r.createdById ? userMap.get(r.createdById) : undefined;
      return {
        id: r.id,
        author: {
          id: r.createdById || 'anonymous',
          name: replyUser?.name || 'Collaborator',
          ...(includeAvatar ? { avatar: replyUser?.avatar || '' } : {}),
        },
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function formatSuggestionItemDto(
  s: ManuscriptTrackChange,
  userMap: ResolvedUserMap,
) {
  const authorUser = s.createdById ? userMap.get(s.createdById) : undefined;
  return {
    id: s.id,
    pageId: s.docId,
    projectPageId: s.docId,
    authorId: s.createdById || 'anonymous',
    author: {
      id: s.createdById || 'anonymous',
      name: authorUser?.name || 'Collaborator',
      email: '',
    },
    type: s.type,
    originalText: s.type === 'delete' ? s.text : '',
    suggestedText: s.type === 'insert' ? s.text : '',
    fromLine: s.startLine,
    fromColumn: s.startCol,
    toLine: s.endLine,
    toColumn: s.endCol,
    description: null,
    status: s.status,
    resolvedById: s.resolvedById,
    resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function formatCreatedSuggestionDto(
  record: ManuscriptTrackChange,
  userId: string | null,
  authorName: string,
  authorEmail: string,
) {
  return {
    id: record.id,
    pageId: record.docId,
    authorId: userId || 'anonymous',
    author: {
      id: userId || 'anonymous',
      name: authorName,
      email: authorEmail,
    },
    type: record.type,
    originalText: record.type === 'delete' ? record.text : '',
    suggestedText: record.type === 'insert' ? record.text : '',
    fromLine: record.startLine,
    fromColumn: record.startCol,
    toLine: record.endLine,
    toColumn: record.endCol,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function findScopedTrackChangeOrThrow(
  prisma: PrismaService,
  pageScopeRepo: ManuscriptPageScopeRepository,
  suggestionId: string,
  resolvedDocId?: string,
  targetProjectId?: string,
): Promise<ManuscriptTrackChange> {
  const existing = targetProjectId
    ? await pageScopeRepo.findTrackChangeInProject(
        targetProjectId,
        suggestionId,
        resolvedDocId && isUuid(resolvedDocId) ? resolvedDocId : undefined,
      )
    : await prisma.manuscriptTrackChange.findUnique({
        where: { id: suggestionId },
      });

  if (
    !existing ||
    (resolvedDocId &&
      isUuid(resolvedDocId) &&
      existing.docId &&
      existing.docId !== resolvedDocId) ||
    (targetProjectId &&
      existing.projectId &&
      existing.projectId !== targetProjectId)
  ) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: 'Suggestion not found',
    });
  }

  return existing;
}

export async function applyAcceptedSingleSuggestionToDocstore(params: {
  prisma: PrismaService;
  docstoreService: DocstoreService;
  live: LiveCollaborationPort | null;
  record: ManuscriptTrackChange;
  targetProjectId?: string;
  syncLiveDoc: (
    projectId: string,
    docId: string,
    lines: string[],
  ) => Promise<boolean>;
  broadcastEvent: (
    projectId: string | null | undefined,
    event: string,
    payload: unknown,
  ) => void;
  logger: Logger;
  suggestionId: string;
}): Promise<void> {
  const {
    prisma,
    docstoreService,
    live,
    record,
    targetProjectId,
    syncLiveDoc,
    broadcastEvent,
    logger,
    suggestionId,
  } = params;
  if (!record.docId) return;

  try {
    let flushProjectId = record.projectId || targetProjectId;
    if (!flushProjectId && record.docId) {
      const preDoc = await prisma.manuscriptDoc.findUnique({
        where: { id: record.docId },
        select: { projectId: true },
      });
      flushProjectId = preDoc?.projectId;
    }
    if (live && flushProjectId) {
      await live.flushDocs(flushProjectId, [record.docId]).catch(() => []);
    }

    const doc = await prisma.manuscriptDoc.findUnique({
      where: { id: record.docId },
      select: {
        id: true,
        lines: true,
        rev: true,
        version: true,
        projectId: true,
        inStorage: true,
      },
    });
    if (
      doc &&
      record.projectId &&
      doc.projectId &&
      record.projectId !== doc.projectId
    ) {
      return;
    }
    if (doc && (Array.isArray(doc.lines) || doc.inStorage)) {
      const lines = await hydrateReviewDocLines(docstoreService, {
        id: doc.id || record.docId,
        projectId: doc.projectId || record.projectId || targetProjectId || '',
        lines: doc.lines,
        inStorage: doc.inStorage,
      });
      applySuggestionToLines(lines, record);

      if (doc.projectId) {
        await docstoreService.updateDoc(doc.projectId, record.docId, {
          lines,
          version: (doc.version || 0) + 1,
        });
        await syncLiveDoc(doc.projectId, record.docId, lines);
      }

      if (doc.projectId) {
        broadcastEvent(doc.projectId, 'track-changes:resolved', {
          docId: record.docId,
          change: record,
          action: 'accepted',
        });
      }
    }
  } catch (patchErr) {
    logger.error(
      `Could not apply accepted track-change to docstore: ${patchErr}`,
    );
    await prisma.manuscriptTrackChange.updateMany({
      where: { id: suggestionId },
      data: { status: 'pending', resolvedAt: null },
    });
    throw new BadRequestException(
      'Failed to patch document content for accepted suggestion',
    );
  }
}

export async function applyAcceptedBatchSuggestionsToDocstore(params: {
  prisma: PrismaService;
  docstoreService: DocstoreService;
  live: LiveCollaborationPort | null;
  pageId: string;
  targetProjectId?: string;
  pendingChanges: ManuscriptTrackChange[];
  ids: string[];
  acceptedCount: number;
  syncLiveDoc: (
    projectId: string,
    docId: string,
    lines: string[],
  ) => Promise<boolean>;
  broadcastEvent: (
    projectId: string | null | undefined,
    event: string,
    payload: unknown,
  ) => void;
  logger: Logger;
}): Promise<void> {
  const {
    prisma,
    docstoreService,
    live,
    pageId,
    targetProjectId,
    pendingChanges,
    ids,
    acceptedCount,
    syncLiveDoc,
    broadcastEvent,
    logger,
  } = params;

  try {
    let flushProjectId = targetProjectId;
    if (!flushProjectId && pageId) {
      const preDoc = await prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      flushProjectId = preDoc?.projectId;
    }
    if (live && flushProjectId) {
      await live.flushDocs(flushProjectId, [pageId]).catch(() => []);
    }

    const doc = await prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
      select: {
        id: true,
        lines: true,
        rev: true,
        version: true,
        projectId: true,
        inStorage: true,
      },
    });

    if (doc && (Array.isArray(doc.lines) || doc.inStorage)) {
      const lines = await hydrateReviewDocLines(docstoreService, {
        id: doc.id || pageId,
        projectId: doc.projectId || targetProjectId || '',
        lines: doc.lines,
        inStorage: doc.inStorage,
      });
      applyBatchSuggestionsToLines(lines, pendingChanges);

      if (doc.projectId) {
        await docstoreService.updateDoc(doc.projectId, pageId, {
          lines,
          version: (doc.version || 0) + 1,
        });
        await syncLiveDoc(doc.projectId, pageId, lines);
      }
    }

    if (acceptedCount > 0 && doc?.projectId) {
      broadcastEvent(doc.projectId, 'track-changes:resolved', {
        docId: pageId,
        bulk: true,
        action: 'accept-all',
        count: acceptedCount,
      });
    }
  } catch (err) {
    logger.error(
      `Failed to apply batch accepted track-changes to docstore for page ${pageId}: ${err}`,
    );
    await prisma.manuscriptTrackChange.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'pending',
        resolvedAt: null,
        resolvedById: null,
      },
    });
    throw err;
  }
}
