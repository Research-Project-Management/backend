/**
 * modules/pages/project-history/services/page-versions.helper.ts
 * Snapshot normalization, file-map construction, and pre-restore safety snapshot helpers.
 */

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { isUuid } from '@/core';
import { getRecordSpaceId } from '@/modules/pages/core/page-scope.helper';
import { LiveCollaborationPort } from '@/modules/pages/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { ProjectHistoryRepository } from '../project-history.repository';
import {
  computeLineDiff,
  FileSnapshotVo,
  SnapshotNormalizer,
  Snapshot,
} from '../domain';

export function extractVersionDocPath(
  doc?: {
    lastKnownPath?: string;
    path?: string;
    node?: { path?: string | null } | null;
  } | null,
): string | undefined {
  return doc?.node?.path || doc?.lastKnownPath || doc?.path;
}

export function pickSnapshotTextFromFiles(
  files: Record<string, unknown>,
  docPath?: string | null,
): string {
  if (!files || Object.keys(files).length === 0) return '';
  const filesMap = SnapshotNormalizer.parseSnapshotFiles(files);
  if (docPath) {
    const normalized = docPath.startsWith('/') ? docPath : `/${docPath}`;
    const hit = filesMap.get(normalized);
    if (hit?.lines) return hit.lines.join('\n');
    if (filesMap.size === 1 && filesMap.has('/main.tex')) {
      return filesMap.get('/main.tex')?.lines?.join('\n') ?? '';
    }
    return '';
  }
  const mainHit = filesMap.get('/main.tex') ?? filesMap.values().next().value;
  return mainHit?.lines ? mainHit.lines.join('\n') : '';
}

export function buildSnapshotFilesMap(params: {
  allDocs: Array<{
    id?: string;
    _id: string;
    path?: string;
    lines?: string[] | unknown;
  }>;
  pageId: string;
  docPath: string;
  targetContent: string;
}): Map<string, FileSnapshotVo> {
  const { allDocs, pageId, docPath, targetContent } = params;
  const filesMap = new Map<string, FileSnapshotVo>();
  let addedTargetDoc = false;

  for (const d of allDocs) {
    const cleanPath = (d.path || '').replace(/^\//, '') || 'main.tex';
    const normalizedPath = `/${cleanPath}`;
    const dId = d.id || d._id;
    const finalText =
      dId === pageId
        ? targetContent
        : Array.isArray(d.lines)
          ? d.lines.join('\n')
          : String(d.lines || '');
    if (dId === pageId || cleanPath === docPath) addedTargetDoc = true;
    const vo = FileSnapshotVo.createDoc(
      normalizedPath,
      dId,
      finalText.split('\n'),
      createHash('sha256').update(finalText).digest('hex'),
      normalizedPath === '/main.tex',
    );
    filesMap.set(vo.path, vo);
  }

  if (!addedTargetDoc) {
    const normalizedTarget = `/${docPath.replace(/^\//, '')}`;
    const vo = FileSnapshotVo.createDoc(
      normalizedTarget,
      isUuid(pageId) ? pageId : '',
      targetContent.split('\n'),
      createHash('sha256').update(targetContent).digest('hex'),
      normalizedTarget === '/main.tex',
    );
    filesMap.set(vo.path, vo);
  }

  return filesMap;
}

export async function savePreRestoreAutoSnapshot(params: {
  historyRepo: ProjectHistoryRepository;
  docstoreService: DocstoreService;
  logger: Logger;
  doc: {
    id: string;
    lines: unknown;
    lastKnownPath?: string;
    path?: string;
    node?: { path?: string | null } | null;
    pageId?: string | null;
  };
  docProjectId: string;
  restoredVersion: number;
  userId?: string;
}): Promise<void> {
  const {
    historyRepo,
    docstoreService,
    logger,
    doc,
    docProjectId,
    restoredVersion,
    userId,
  } = params;
  const docPageId = doc.pageId ?? undefined;
  try {
    const [latestVersion, hydratedDoc] = await Promise.all([
      historyRepo.getLatestVersion(docProjectId, docPageId),
      docstoreService.getDoc(docProjectId, doc.id).catch(() => null),
    ]);
    const currentLines = Array.isArray(hydratedDoc?.lines)
      ? hydratedDoc.lines
      : Array.isArray(doc.lines)
        ? (doc.lines as string[])
        : [];
    const currentDocPath = extractVersionDocPath(doc) || 'main.tex';
    const normalizedDocPath = currentDocPath.startsWith('/')
      ? currentDocPath
      : `/${currentDocPath}`;
    const autoMap = new Map<string, FileSnapshotVo>();
    const vo = FileSnapshotVo.createDoc(
      normalizedDocPath,
      doc.id,
      currentLines,
      createHash('sha256').update(currentLines.join('\n')).digest('hex'),
      normalizedDocPath === '/main.tex',
    );
    autoMap.set(vo.path, vo);
    await historyRepo.saveSnapshot(
      Snapshot.create({
        projectId: docProjectId,
        spaceId: docProjectId,
        pageId: docPageId,
        version: latestVersion + 1,
        summary: `Auto-snapshot before restoring version ${restoredVersion}`,
        createdById: isUuid(userId) ? userId : null,
        files: autoMap,
      }),
    );
  } catch (snapErr) {
    logger.warn(`Failed to create pre-restore auto-snapshot: ${snapErr}`);
  }
}

export async function computeVersionDiffPayload(params: {
  pageId: string;
  from: string;
  to: string;
  activeProjectId?: string;
  pageScopeRepo: ScopeRepository;
  pageService: PageService;
  historyRepo?: ProjectHistoryRepository;
  liveCollab: LiveCollaborationPort;
}) {
  const {
    pageId,
    from,
    to,
    activeProjectId,
    pageScopeRepo,
    pageService,
    historyRepo,
    liveCollab,
  } = params;
  const doc =
    isUuid(pageId) && activeProjectId
      ? await pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;

  const targetProjectId =
    activeProjectId ||
    getRecordSpaceId(doc) ||
    (await pageService.resolveProjectId(pageId));
  if (!targetProjectId) {
    throw new NotFoundException('Document or project context not found');
  }

  const loadSnap = async (id: string) => {
    if (!isUuid(id) || !historyRepo) return null;
    const snap = await historyRepo.findSnapshotInProject(targetProjectId, id);
    const snapProjectId = getRecordSpaceId(snap);
    if (!snap || snapProjectId !== targetProjectId) {
      throw new NotFoundException(`Version ${id} not found`);
    }
    if (doc && snapProjectId !== getRecordSpaceId(doc)) {
      throw new BadRequestException(
        `Version ${id} does not belong to this document's project`,
      );
    }
    return snap;
  };

  const [snapFrom, snapTo] = await Promise.all([loadSnap(from), loadSnap(to)]);
  if (!snapFrom && !snapTo) {
    throw new BadRequestException(
      'At least one valid version id (from/to) is required',
    );
  }
  if ((!snapFrom || !snapTo) && isUuid(pageId)) {
    await liveCollab.flushDocs(targetProjectId, [pageId]).catch(() => []);
  }

  const freshDoc =
    (!snapFrom || !snapTo) && isUuid(pageId)
      ? (await pageScopeRepo.findDocInProject(targetProjectId, pageId)) || doc
      : doc;
  const currentLines = freshDoc
    ? await pageService.getHydratedDocLines(freshDoc)
    : [];
  const currentText = currentLines.join('\n');
  const docPath = extractVersionDocPath(doc);
  const pick = (files: Record<string, unknown> | undefined | null) =>
    pickSnapshotTextFromFiles(files || {}, docPath);

  const textFrom = snapFrom
    ? pick(snapFrom.files as Record<string, unknown>)
    : currentText;
  const textTo = snapTo
    ? pick(snapTo.files as Record<string, unknown>)
    : currentText;
  const result = computeLineDiff(textFrom, textTo, {
    from: snapFrom ? `v${snapFrom.version}` : 'current',
    to: snapTo ? `v${snapTo.version}` : 'current',
  });

  return {
    fromVersionId: from,
    toVersionId: to,
    fromContent: textFrom,
    toContent: textTo,
    diff: result.unified,
    chunks: result.hunks.map((h) => ({
      type: 'change',
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      content: h.lines.join('\n'),
      value: h.lines.join('\n'),
      lines: h.lines,
      linesCount: h.lines.length,
    })),
    stats: {
      additions: result.stats.additions,
      deletions: result.stats.deletions,
      addedLines: result.stats.additions,
      deletedLines: result.stats.deletions,
      unchangedLines: result.stats.unchanged,
    },
  };
}
