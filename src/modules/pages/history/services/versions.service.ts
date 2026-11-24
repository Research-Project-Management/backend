/**
 * modules/pages/history/services/versions.service.ts
 * Application service encapsulating snapshot version listing, unified diffs,
 * point-in-time reads, manual/auto snapshot creation, labeling, and rollback restore.
 */

import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { AuthenticatedRequest, isUuid } from '@/core';
import {
  getRecordSpaceId,
  resolveActiveProjectId,
} from '@/modules/pages/core/page-scope.helper';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { HistoryRepository } from '../repositories/history.repository';
import { Snapshot } from '../domain/snapshot.domain';
import { VersionLabel } from '../domain/version-label.domain';
import { computeLineDiff } from '../domain/diff.domain';
import { FileSnapshotVo } from '../domain/file-snapshot.domain';
import { SnapshotNormalizer } from '../domain/snapshot.mapper';

@Injectable()
export class VersionsService {
  private readonly logger = new Logger(VersionsService.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly historyRepo?: HistoryRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
  ) {
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  private async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    try {
      return await this.liveCollab.applyExternalText(
        projectId,
        docId,
        lines.join('\n'),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to sync REST write into live session ${projectId}:${docId}: ${message}`,
      );
      return false;
    }
  }

  public async getVersions(
    pageId: string,
    project?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { versions: [] };
    try {
      const activeProjectId = resolveActiveProjectId(project);
      if (activeProjectId) {
        await this.liveCollab.flushDoc(activeProjectId, pageId).catch(() => []);
      }
      const doc = activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : null;
      const projectId =
        getRecordSpaceId(doc) ||
        activeProjectId ||
        (await this.pageService.resolveProjectId(pageId));
      if (!projectId || !isUuid(projectId)) return { versions: [] };

      const targetPageId =
        (doc as { pageId?: string | null } | null)?.pageId || pageId;
      const snapshots = this.historyRepo
        ? await this.historyRepo.listVersions(projectId, targetPageId)
        : [];
      const userMap = await this.userResolver.resolveUserNames(
        snapshots.map((s) => s.createdById),
      );

      const versions = snapshots.map((s) => {
        const savedByUser = s.createdById
          ? userMap.get(s.createdById)
          : undefined;
        return {
          id: s.id,
          title: `v${s.version} Snapshot`,
          label: s.labels?.[0]?.label || s.summary || `Version ${s.version}`,
          fileName: 'main.tex',
          savedBy: {
            id: s.createdById || 'anonymous',
            name: savedByUser?.name || 'Collaborator',
          },
          createdAt: s.createdAt.toISOString(),
        };
      });
      return { versions };
    } catch {
      return { versions: [] };
    }
  }

  public async getDiff(
    pageId: string,
    from: string,
    to: string,
    project?: string | { id: string } | null,
  ) {
    return computeVersionDiffPayload({
      pageId,
      from,
      to,
      activeProjectId: resolveActiveProjectId(project),
      pageScopeRepo: this.pageScopeRepo,
      pageService: this.pageService,
      historyRepo: this.historyRepo,
      liveCollab: this.liveCollab,
    });
  }

  public async getVersionById(
    pageId: string,
    versionId: string,
    project?: string | { id: string } | null,
  ) {
    if (!isUuid(versionId)) return { version: null };
    try {
      const activeProjectId = resolveActiveProjectId(project);
      const [s, doc] = await Promise.all([
        activeProjectId && this.historyRepo
          ? this.historyRepo.findSnapshotInProject(activeProjectId, versionId)
          : null,
        isUuid(pageId) && activeProjectId
          ? this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
          : Promise.resolve(null),
      ]);
      if (!s) return { version: null };
      const snapProjectId = getRecordSpaceId(s);
      if (activeProjectId && snapProjectId !== activeProjectId) {
        return { version: null };
      }
      if (doc && snapProjectId !== getRecordSpaceId(doc)) {
        return { version: null };
      }

      const userMap = await this.userResolver.resolveUserNames([s.createdById]);
      const savedByUser = s.createdById
        ? userMap.get(s.createdById)
        : undefined;
      const filesObj =
        s.files && typeof s.files === 'object'
          ? (s.files as Record<string, unknown>)
          : {};
      const initialDocPath = extractVersionDocPath(doc);
      const fileName = initialDocPath
        ? initialDocPath.replace(/^\//, '') || 'main.tex'
        : 'main.tex';

      return {
        version: {
          id: s.id,
          title: `v${s.version} Snapshot`,
          label: s.labels?.[0]?.label || s.summary || `Version ${s.version}`,
          fileName,
          savedBy: {
            id: s.createdById || 'anonymous',
            name: savedByUser?.name || 'Collaborator',
          },
          createdAt: s.createdAt.toISOString(),
          content: pickSnapshotTextFromFiles(
            filesObj,
            initialDocPath || 'main.tex',
          ),
        },
      };
    } catch {
      return { version: null };
    }
  }

  public async createVersion(
    pageId: string,
    body: { label?: string; content?: string },
    req: AuthenticatedRequest,
    project?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | undefined = resolveActiveProjectId(project);
    let docPath = 'main.tex';
    let currentContent = '';
    let resolvedPageId: string | undefined = isUuid(pageId)
      ? pageId
      : undefined;
    if (isUuid(pageId)) {
      const initialDoc = projectId
        ? await this.pageScopeRepo.findDocInProject(projectId, pageId)
        : null;
      projectId =
        getRecordSpaceId(initialDoc) ||
        projectId ||
        (await this.pageService.resolveProjectId(pageId)) ||
        undefined;
      resolvedPageId =
        (initialDoc as { pageId?: string | null } | null)?.pageId || pageId;
      const initialPath = extractVersionDocPath(initialDoc);
      if (initialPath) {
        docPath = initialPath.replace(/^\//, '') || docPath;
      }
    }

    if (!projectId || !isUuid(projectId)) {
      throw new NotFoundException(`Project not found for doc ${pageId}`);
    }

    await this.liveCollab.flushDocs(projectId, []).catch(() => []);
    if (isUuid(pageId) && typeof body.content !== 'string') {
      const freshDoc = await this.pageScopeRepo.findDocInProject(
        projectId,
        pageId,
      );
      if (freshDoc) {
        resolvedPageId =
          (freshDoc as { pageId?: string | null })?.pageId || resolvedPageId;
        const docLines = await this.pageService.getHydratedDocLines(freshDoc);
        currentContent = docLines.join('\n');
      }
    }

    const content =
      typeof body.content === 'string' ? body.content : currentContent;
    if (!this.historyRepo) {
      throw new InternalServerErrorException(
        'History repository not initialized',
      );
    }

    try {
      const [latestVersion, allDocs, userMap] = await Promise.all([
        this.historyRepo.getLatestVersion(projectId, resolvedPageId),
        this.docstoreService.getAllDocs(projectId, resolvedPageId),
        this.userResolver.resolveUserNames([userId]),
      ]);
      const filesMap = buildSnapshotFilesMap({
        allDocs,
        pageId,
        docPath,
        targetContent: content,
      });
      const resolvedUser = userId ? userMap.get(userId) : undefined;
      const authorName =
        resolvedUser?.name ||
        req?.user?.name ||
        req?.user?.email?.split('@')[0] ||
        'Collaborator';

      const snap = await this.historyRepo.saveSnapshot(
        Snapshot.create({
          projectId,
          spaceId: projectId,
          pageId: resolvedPageId,
          version: latestVersion + 1,
          summary: body.label || 'Manual Snapshot',
          createdById: isUuid(userId) ? userId : null,
          files: filesMap,
        }),
      );
      if (body.label && body.label.trim()) {
        await this.historyRepo
          .saveLabel(
            VersionLabel.create({
              projectId,
              spaceId: projectId,
              pageId: snap.pageId ?? resolvedPageId,
              snapshotId: snap.id,
              version: snap.version,
              label: body.label.trim(),
              createdById: isUuid(userId) ? userId : null,
            }),
          )
          .catch(() => null);
      }

      return {
        version: {
          id: snap.id,
          title: `v${snap.version} Snapshot`,
          label: body.label || `Version ${snap.version}`,
          fileName: docPath,
          savedBy: { id: userId || 'anonymous', name: authorName },
          createdAt: snap.createdAt.toISOString(),
          content,
        },
      };
    } catch (err: unknown) {
      const status = (err as { status?: number; statusCode?: number })?.status;
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (
        (typeof status === 'number' && status >= 400 && status < 500) ||
        (typeof statusCode === 'number' &&
          statusCode >= 400 &&
          statusCode < 500)
      ) {
        throw err;
      }
      throw new InternalServerErrorException(
        'Failed to create snapshot version',
      );
    }
  }

  public async restoreVersion(
    pageId: string,
    versionId: string,
    project?: string | { id: string } | null,
    userId?: string,
  ) {
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');
    const activeProjectId = resolveActiveProjectId(project);
    const [snap, doc] = await Promise.all([
      activeProjectId && this.historyRepo
        ? this.historyRepo.findSnapshotInProject(activeProjectId, versionId)
        : null,
      isUuid(pageId) && activeProjectId
        ? this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : null,
    ]);
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);
    if (!doc) throw new NotFoundException(`Document ${pageId} not found`);

    const snapProjectId = getRecordSpaceId(snap);
    const docProjectId = getRecordSpaceId(doc);
    if (snapProjectId !== docProjectId) {
      throw new BadRequestException(
        'Version does not belong to this document project',
      );
    }

    await this.liveCollab.flushDoc(docProjectId, doc.id).catch(() => {});

    if (this.historyRepo) {
      await savePreRestoreAutoSnapshot({
        historyRepo: this.historyRepo,
        docstoreService: this.docstoreService,
        logger: this.logger,
        doc,
        docProjectId,
        restoredVersion: snap.version,
        userId,
      });
    }

    const freshDoc = await this.pageScopeRepo.findDocInProject(
      docProjectId,
      doc.id,
    );
    const targetRev = freshDoc?.rev ?? doc.rev;
    const targetVer = (freshDoc?.version ?? doc.version) + 1;
    const files = (snap.files as Record<string, unknown>) || {};
    const lines = pickSnapshotTextFromFiles(
      files,
      extractVersionDocPath(doc),
    ).split('\n');

    await this.docstoreService.updateDoc(docProjectId, doc.id, {
      lines,
      version: targetVer,
      expectedRev: targetRev,
    });
    const liveSessionSynced = await this.syncLiveDoc(
      docProjectId,
      doc.id,
      lines,
    );

    this.eventEmitter?.emit('pages.project.event', {
      projectId: docProjectId,
      event: 'version:restored',
      payload: {
        docId: doc.id,
        versionId,
        restoredVersion: snap.version,
        actorId: userId,
      },
    });

    return {
      success: true,
      restoredVersion: snap.version,
      liveSessionSynced,
    };
  }

  public async labelVersion(
    versionId: string,
    body: { label: string; title?: string },
    req: AuthenticatedRequest,
    project?: string | { id: string } | null,
  ) {
    const labelName = body?.label?.trim();
    if (!labelName) throw new BadRequestException('Label cannot be empty');
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');

    const activeProjectId = resolveActiveProjectId(project);
    const snap =
      activeProjectId && this.historyRepo
        ? await this.historyRepo.findSnapshotInProject(
            activeProjectId,
            versionId,
          )
        : null;
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const userId = req?.user?.id || req?.user?.sub || null;
    if (this.historyRepo) {
      await this.historyRepo.saveLabel(
        VersionLabel.create({
          projectId: getRecordSpaceId(snap),
          snapshotId: versionId,
          version: snap.version,
          label: labelName,
          createdById: isUuid(userId) ? userId : null,
        }),
      );
    }

    return {
      version: {
        id: versionId,
        label: labelName,
        title: body.title || labelName,
        createdAt: new Date().toISOString(),
      },
    };
  }

  public async getTimeline(
    pageId: string,
    project?: string | { id: string } | null,
  ) {
    let projectId: string | undefined = resolveActiveProjectId(project);
    let targetPageId: string | undefined = isUuid(pageId) ? pageId : undefined;
    if (isUuid(pageId)) {
      const doc = projectId
        ? await this.pageScopeRepo.findDocInProject(projectId, pageId)
        : null;
      projectId =
        getRecordSpaceId(doc) ||
        projectId ||
        (await this.pageService.resolveProjectId(pageId)) ||
        undefined;
      targetPageId =
        (doc as { pageId?: string | null } | null)?.pageId || pageId;
    }

    if (!projectId || !isUuid(projectId)) {
      return {
        entries: [],
        oldestMs: Date.now() - 3600000,
        newestMs: Date.now(),
      };
    }

    const snapshots = this.historyRepo
      ? await this.historyRepo.listVersions(projectId, targetPageId)
      : [];
    const userMap = await this.userResolver.resolveUserNames(
      snapshots.map((s) => s.createdById),
    );

    const entries = snapshots.slice(0, 50).map((s) => {
      const authorUser = s.createdById ? userMap.get(s.createdById) : undefined;
      return {
        id: s.id,
        version: s.version,
        summary: s.labels?.[0]?.label || s.summary || `v${s.version}`,
        timestamp: s.createdAt.getTime(),
        createdAt: s.createdAt.toISOString(),
        author: {
          id: s.createdById || 'collaborator',
          name: authorUser?.name || 'Collaborator',
        },
      };
    });

    return {
      entries,
      oldestMs:
        entries.length > 0
          ? entries[entries.length - 1].timestamp
          : Date.now() - 3600000,
      newestMs: entries.length > 0 ? entries[0].timestamp : Date.now(),
    };
  }

  public async getAt(
    pageId: string,
    timestamp?: string,
    project?: string | { id: string } | null,
  ) {
    let targetTime = timestamp
      ? new Date(Number(timestamp) || timestamp)
      : new Date();
    if (isNaN(targetTime.getTime())) targetTime = new Date();

    const activeProjectId = resolveActiveProjectId(project);
    const doc =
      isUuid(pageId) && activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : null;
    if (!doc) throw new NotFoundException(`Document ${pageId} not found`);

    const docPath = extractVersionDocPath(doc) || '';
    const normalizedPath = `/${docPath.replace(/^\//, '')}`;
    const matchesTargetDoc = (s: Snapshot) =>
      s.files.has(normalizedPath) ||
      (s.files.size === 1 && s.files.has('/main.tex'));

    const allSnaps = this.historyRepo
      ? await this.historyRepo.listVersions(
          getRecordSpaceId(doc),
          (doc as { pageId?: string | null }).pageId ?? undefined,
        )
      : [];
    const snap = allSnaps
      .filter((s) => s.createdAt.getTime() <= targetTime.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .find(matchesTargetDoc);

    if (!snap) {
      return { content: '', timestamp: targetTime.getTime(), found: false };
    }
    return {
      content: pickSnapshotTextFromFiles(snap.toFilesJson(), docPath),
      timestamp: snap.createdAt.getTime(),
      versionId: snap.id,
      version: snap.version,
      found: true,
    };
  }
}

function extractVersionDocPath(
  doc?: {
    lastKnownPath?: string;
    path?: string;
    node?: { path?: string | null } | null;
  } | null,
): string | undefined {
  return doc?.node?.path || doc?.lastKnownPath || doc?.path;
}

function pickSnapshotTextFromFiles(
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

function buildSnapshotFilesMap(params: {
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

async function savePreRestoreAutoSnapshot(params: {
  historyRepo: HistoryRepository;
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

async function computeVersionDiffPayload(params: {
  pageId: string;
  from: string;
  to: string;
  activeProjectId?: string;
  pageScopeRepo: ScopeRepository;
  pageService: PageService;
  historyRepo?: HistoryRepository;
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
