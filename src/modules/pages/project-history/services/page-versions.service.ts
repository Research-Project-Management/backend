/**
 * modules/pages/project-history/services/page-versions.service.ts
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
import { ProjectHistoryRepository } from '../project-history.repository';
import { Snapshot, VersionLabel } from '../domain';
import {
  extractVersionDocPath,
  pickSnapshotTextFromFiles,
  buildSnapshotFilesMap,
  savePreRestoreAutoSnapshot,
  computeVersionDiffPayload,
} from './page-versions.helper';

@Injectable()
export class PageVersionsService {
  private readonly logger = new Logger(PageVersionsService.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly historyRepo?: ProjectHistoryRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
  ) {
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
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

    this.eventEmitter?.emit('manuscripts.project.event', {
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
