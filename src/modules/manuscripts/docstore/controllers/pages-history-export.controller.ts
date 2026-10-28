/**
 * modules/manuscripts/docstore/controllers/pages-history-export.controller.ts
 * Domain-focused controller handling Version History, Diff, Timeline, Point-in-Time At,
 * Document Export, and Compiler Incremental Sync routes.
 * Delegates aggregate lifecycle and business logic to ProjectHistoryService,
 * ExportImportService, DocstoreService, and ManuscriptPageService without raw Prisma queries.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  HttpStatus,
  HttpCode,
  Optional,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
  Logger,
  UseGuards,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
} from '@/modules/project/access';
import { AuthenticatedRequest, isUuid } from '@/core';
import { createHash } from 'crypto';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptUserResolverService } from '../services/manuscript-user-resolver.service';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { ManuscriptPageService } from '@/modules/manuscripts/core/services/manuscript-page.service';
import { ExportImportService } from '@/modules/manuscripts/export-import/export-import.service';
import { resolveIncludedLatexContent } from '@/modules/manuscripts/export-import/domain';
import { ProjectHistoryService } from '@/modules/manuscripts/project-history/project-history.service';
import { ProjectHistoryRepository } from '@/modules/manuscripts/project-history/project-history.repository';
import {
  computeLineDiff,
  FileSnapshotVo,
  SnapshotNormalizer,
  Snapshot,
  VersionLabel,
} from '@/modules/manuscripts/project-history/domain';

@ApiTags('Manuscripts - Pages History & Export')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PagesHistoryExportController {
  private readonly logger = new Logger(PagesHistoryExportController.name);
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly pageScopeRepo: ManuscriptPageScopeRepository,
    private readonly userResolver: ManuscriptUserResolverService,
    private readonly pageService: ManuscriptPageService,
    @Optional()
    @Inject(forwardRef(() => ProjectHistoryService))
    private readonly projectHistoryService?: ProjectHistoryService,
    @Optional()
    @Inject(forwardRef(() => ProjectHistoryRepository))
    private readonly historyRepo?: ProjectHistoryRepository,
    @Optional()
    @Inject(forwardRef(() => ExportImportService))
    private readonly exportImportService?: ExportImportService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private getLiveCollaboration(): LiveCollaborationPort | null {
    if (this.liveCollab !== undefined) return this.liveCollab;
    try {
      this.liveCollab =
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null;
    } catch {
      this.liveCollab = null;
    }
    return this.liveCollab;
  }

  private async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    const live = this.getLiveCollaboration();
    if (!live) return false;
    try {
      return await live.applyExternalText(projectId, docId, lines.join('\n'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to sync REST write into live session ${projectId}:${docId}: ${message}`,
      );
      return false;
    }
  }

  private async resolveUserNames(
    userIds: (string | null | undefined)[],
  ): Promise<Map<string, { id: string; name: string; avatar?: string }>> {
    return this.userResolver.resolveUserNames(userIds);
  }

  /** Selects the snapshot entry for a doc path using canonical SnapshotNormalizer. */
  private pickSnapshotText(
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

  private resolveActiveProjectId(
    project?: string | { id: string } | null,
  ): string | undefined {
    return this.pageService.resolveActiveProjectId(project);
  }

  private async getHydratedDocLines(doc: {
    id: string;
    projectId: string;
    lines: unknown;
    inStorage?: boolean;
  }): Promise<string[]> {
    return this.pageService.getHydratedDocLines(doc);
  }

  // ─── 1. VERSION HISTORY & SNAPSHOTS ──────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/pages/:pageId/versions
   * GET /api/v1/manuscripts/docs/:pageId/versions
   */
  @Get(['pages/:pageId/versions', 'docs/:pageId/versions'])
  async getVersions(
    @Param('pageId') pageId: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { versions: [] };
    try {
      const activeProjectId = this.resolveActiveProjectId(project);
      if (activeProjectId) {
        await this.getLiveCollaboration()
          ?.flushDoc(activeProjectId, pageId)
          .catch(() => []);
      }
      const doc = activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : null;
      const projectId =
        doc?.projectId ||
        activeProjectId ||
        (await this.pageService.resolveProjectId(pageId));
      if (!projectId || !isUuid(projectId)) return { versions: [] };

      const snapshots = this.historyRepo
        ? await this.historyRepo.listVersions(projectId)
        : [];

      const userMap = await this.resolveUserNames(
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

  /**
   * GET /api/v1/manuscripts/pages/:pageId/versions/diff
   * GET /api/v1/manuscripts/pages/:pageId/diff
   * GET /api/v1/manuscripts/docs/:pageId/versions/diff
   * GET /api/v1/manuscripts/docs/:pageId/diff
   */
  @Get([
    'pages/:pageId/versions/diff',
    'pages/:pageId/diff',
    'docs/:pageId/versions/diff',
    'docs/:pageId/diff',
  ])
  async getDiff(
    @Param('pageId') pageId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    const activeProjectId = this.resolveActiveProjectId(project);
    const doc = isUuid(pageId)
      ? activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : null
      : null;

    const targetProjectId =
      activeProjectId ||
      doc?.projectId ||
      (await this.pageService.resolveProjectId(pageId));
    if (!targetProjectId) {
      throw new NotFoundException('Document or project context not found');
    }

    const loadSnap = async (id: string) => {
      if (!isUuid(id)) return null;
      const snap = await this.pageScopeRepo.findSnapshotInProject(
        targetProjectId,
        id,
      );
      if (!snap || snap.projectId !== targetProjectId) {
        throw new NotFoundException(`Version ${id} not found`);
      }
      if (doc && snap.projectId !== doc.projectId) {
        throw new BadRequestException(
          `Version ${id} does not belong to this document's project`,
        );
      }
      return snap;
    };

    const snapFrom = await loadSnap(from);
    const snapTo = await loadSnap(to);
    if (!snapFrom && !snapTo) {
      throw new BadRequestException(
        'At least one valid version id (from/to) is required',
      );
    }

    if ((!snapFrom || !snapTo) && isUuid(pageId)) {
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(targetProjectId, [pageId]).catch(() => []);
      }
    }

    const freshDoc =
      (!snapFrom || !snapTo) && isUuid(pageId)
        ? (await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)) ||
          doc
        : doc;

    const currentLines = freshDoc
      ? await this.getHydratedDocLines(freshDoc)
      : [];
    const currentText = currentLines.join('\n');
    const pick = (files: Record<string, unknown> | undefined | null) =>
      this.pickSnapshotText(files || {}, doc?.path);

    // A missing side means "current document content".
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

  /**
   * GET /api/v1/manuscripts/pages/:pageId/versions/:versionId
   * GET /api/v1/manuscripts/docs/:pageId/versions/:versionId
   */
  @Get([
    'pages/:pageId/versions/:versionId',
    'docs/:pageId/versions/:versionId',
  ])
  async getVersionById(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    if (!isUuid(versionId)) return { version: null };
    try {
      const activeProjectId = this.resolveActiveProjectId(project);
      const [s, doc] = await Promise.all([
        activeProjectId
          ? this.pageScopeRepo.findSnapshotInProject(activeProjectId, versionId)
          : null,
        isUuid(pageId) && activeProjectId
          ? this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
          : Promise.resolve(null),
      ]);
      if (!s) return { version: null };
      if (activeProjectId && s.projectId !== activeProjectId)
        return { version: null };
      if (doc && s.projectId !== doc.projectId) return { version: null };

      const userMap = await this.resolveUserNames([s.createdById]);
      const savedByUser = s.createdById
        ? userMap.get(s.createdById)
        : undefined;
      const filesObj =
        s.files && typeof s.files === 'object'
          ? (s.files as Record<string, unknown>)
          : {};
      const fileName = doc?.path
        ? doc.path.replace(/^\//, '') || 'main.tex'
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
          content: this.pickSnapshotText(filesObj, doc?.path || 'main.tex'),
        },
      };
    } catch {
      return { version: null };
    }
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/versions
   * POST /api/v1/manuscripts/docs/:pageId/versions
   */
  @Post(['pages/:pageId/versions', 'docs/:pageId/versions'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('pageId') pageId: string,
    @Body() body: { label?: string; content?: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | undefined = this.resolveActiveProjectId(project);
    let docPath = 'main.tex';
    let currentContent = '';
    if (isUuid(pageId)) {
      const initialDoc = projectId
        ? await this.pageScopeRepo.findDocInProject(projectId, pageId)
        : null;
      projectId =
        initialDoc?.projectId ||
        projectId ||
        (await this.pageService.resolveProjectId(pageId)) ||
        undefined;
      if (initialDoc?.path) {
        docPath = initialDoc.path.replace(/^\//, '') || docPath;
      }
    }

    if (!projectId || !isUuid(projectId)) {
      throw new NotFoundException(`Project not found for doc ${pageId}`);
    }

    const live = this.getLiveCollaboration();
    if (live) {
      await live.flushDocs(projectId, []).catch(() => []);
    }

    if (isUuid(pageId) && typeof body.content !== 'string') {
      const freshDoc = await this.pageScopeRepo.findDocInProject(
        projectId,
        pageId,
      );
      if (freshDoc) {
        const docLines = await this.getHydratedDocLines(freshDoc);
        currentContent = docLines.join('\n');
      }
    }

    const content =
      typeof body.content === 'string' ? body.content : currentContent;

    try {
      const [latestVersion, allDocs, userMap] = await Promise.all([
        this.historyRepo
          ? this.historyRepo.getLatestVersion(projectId)
          : Promise.resolve(0),
        this.docstoreService.getAllDocs(projectId),
        this.resolveUserNames([userId]),
      ]);
      const nextVersion = latestVersion + 1;

      const filesMap = new Map<string, FileSnapshotVo>();
      let addedTargetDoc = false;
      for (const d of allDocs) {
        const cleanPath = (d.path || '').replace(/^\//, '') || 'main.tex';
        const normalizedPath = `/${cleanPath}`;
        let finalText: string;
        const dId = d.id || d._id;
        if (dId === pageId) {
          finalText = content;
        } else {
          finalText = Array.isArray(d.lines)
            ? d.lines.join('\n')
            : String(d.lines || '');
        }
        if (dId === pageId || cleanPath === docPath) {
          addedTargetDoc = true;
        }
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
          content.split('\n'),
          createHash('sha256').update(content).digest('hex'),
          normalizedTarget === '/main.tex',
        );
        filesMap.set(vo.path, vo);
      }

      const resolvedUser = userId ? userMap.get(userId) : undefined;
      const authorName =
        resolvedUser?.name ||
        req?.user?.name ||
        req?.user?.email?.split('@')[0] ||
        'Collaborator';

      const snapshot = Snapshot.create({
        projectId,
        version: nextVersion,
        summary: body.label || 'Manual Snapshot',
        createdById: isUuid(userId) ? userId : null,
        files: filesMap,
      });

      if (!this.historyRepo) {
        throw new InternalServerErrorException(
          'History repository not initialized',
        );
      }

      const snap = await this.historyRepo.saveSnapshot(snapshot);
      if (body.label && body.label.trim()) {
        const vLabel = VersionLabel.create({
          projectId,
          snapshotId: snap.id,
          version: snap.version,
          label: body.label.trim(),
          createdById: isUuid(userId) ? userId : null,
        });
        await this.historyRepo.saveLabel(vLabel).catch(() => null);
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
    } catch {
      throw new InternalServerErrorException(
        'Failed to create snapshot version',
      );
    }
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/versions/:versionId/restore
   * POST /api/v1/manuscripts/docs/:pageId/versions/:versionId/restore
   */
  @Post([
    'pages/:pageId/versions/:versionId/restore',
    'docs/:pageId/versions/:versionId/restore',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @ResolvedProject() project?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');
    const activeProjectId = this.resolveActiveProjectId(project);
    const snap = activeProjectId
      ? await this.pageScopeRepo.findSnapshotInProject(
          activeProjectId,
          versionId,
        )
      : null;
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const files = (snap.files as Record<string, unknown>) || {};
    const doc = isUuid(pageId) && activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;

    if (doc) {
      if (snap.projectId !== doc.projectId) {
        throw new BadRequestException(
          'Version does not belong to this document project',
        );
      }

      // Flush active live Yjs session before capturing pre-restore safety snapshot
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDoc(doc.projectId, doc.id).catch(() => {});
      }

      // Pre-restore auto-snapshot to guarantee non-destructive recovery (hydrating cold-storage if needed)
      if (this.historyRepo) {
        try {
          const latestVersion = await this.historyRepo.getLatestVersion(
            doc.projectId,
          );
          const nextVersion = latestVersion + 1;
          const hydratedDoc = await this.docstoreService
            .getDoc(doc.projectId, doc.id)
            .catch(() => null);
          const currentLines = Array.isArray(hydratedDoc?.lines)
            ? hydratedDoc.lines
            : Array.isArray(doc.lines)
              ? (doc.lines as string[])
              : [];
          const currentContent = currentLines.join('\n');
          const autoMap = new Map<string, FileSnapshotVo>();
          const vo = FileSnapshotVo.createDoc(
            doc.path,
            doc.id,
            currentLines,
            createHash('sha256').update(currentContent).digest('hex'),
            doc.path === '/main.tex',
          );
          autoMap.set(vo.path, vo);
          await this.historyRepo.saveSnapshot(
            Snapshot.create({
              projectId: doc.projectId,
              version: nextVersion,
              summary: `Auto-snapshot before restoring version ${snap.version}`,
              createdById: isUuid(userId) ? userId : null,
              files: autoMap,
            }),
          );
        } catch (snapErr) {
          this.logger.warn(
            `Failed to create pre-restore auto-snapshot: ${snapErr}`,
          );
        }
      }

      const freshDoc = await this.pageScopeRepo.findDocInProject(
        doc.projectId,
        doc.id,
      );
      const targetRev = freshDoc?.rev ?? doc.rev;
      const targetVer = (freshDoc?.version ?? doc.version) + 1;

      const restoredText = this.pickSnapshotText(files, doc.path);
      const lines = restoredText.split('\n');
      await this.docstoreService.updateDoc(doc.projectId, doc.id, {
        lines,
        version: targetVer,
        expectedRev: targetRev,
      });
      const liveSessionSynced = await this.syncLiveDoc(
        doc.projectId,
        doc.id,
        lines,
      );

      this.eventEmitter?.emit('manuscripts.project.event', {
        projectId: doc.projectId,
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
    throw new NotFoundException(`Document ${pageId} not found`);
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/versions/:versionId/label
   * POST /api/v1/manuscripts/docs/:pageId/versions/:versionId/label
   */
  @Post([
    'pages/:pageId/versions/:versionId/label',
    'docs/:pageId/versions/:versionId/label',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async labelVersion(
    @Param('versionId') versionId: string,
    @Body() body: { label: string; title?: string },
    @Req() req: AuthenticatedRequest,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    const labelName = body?.label?.trim();
    if (!labelName) throw new BadRequestException('Label cannot be empty');
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');

    const activeProjectId = this.resolveActiveProjectId(project);
    const snap = activeProjectId
      ? await this.pageScopeRepo.findSnapshotInProject(
          activeProjectId,
          versionId,
        )
      : null;
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const userId = req?.user?.id || req?.user?.sub || null;

    if (this.historyRepo) {
      await this.historyRepo.saveLabel(
        VersionLabel.create({
          projectId: snap.projectId,
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

  /**
   * GET /api/v1/manuscripts/pages/:pageId/timeline
   * GET /api/v1/manuscripts/docs/:pageId/timeline
   */
  @Get(['pages/:pageId/timeline', 'docs/:pageId/timeline'])
  async getTimeline(
    @Param('pageId') pageId: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    let projectId: string | undefined = this.resolveActiveProjectId(project);
    if (isUuid(pageId)) {
      const doc = projectId
        ? await this.pageScopeRepo.findDocInProject(projectId, pageId)
        : null;
      projectId =
        doc?.projectId ||
        projectId ||
        (await this.pageService.resolveProjectId(pageId)) ||
        undefined;
    }

    if (!projectId || !isUuid(projectId)) {
      return {
        entries: [],
        oldestMs: Date.now() - 3600000,
        newestMs: Date.now(),
      };
    }

    const snapshots = this.historyRepo
      ? await this.historyRepo.listVersions(projectId)
      : [];

    const userMap = await this.resolveUserNames(
      snapshots.map((s) => s.createdById),
    );

    const entries = snapshots.slice(0, 50).map((s) => {
      const authorUser = s.createdById
        ? userMap.get(s.createdById)
        : undefined;
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

  /**
   * GET /api/v1/manuscripts/pages/:pageId/at
   * GET /api/v1/manuscripts/docs/:pageId/at
   */
  @Get(['pages/:pageId/at', 'docs/:pageId/at'])
  async getAt(
    @Param('pageId') pageId: string,
    @Query('timestamp') timestamp?: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    let targetTime = timestamp
      ? new Date(Number(timestamp) || timestamp)
      : new Date();
    if (isNaN(targetTime.getTime())) targetTime = new Date();

    const activeProjectId = this.resolveActiveProjectId(project);
    const doc = isUuid(pageId) && activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;
    if (!doc) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const normalizedPath = `/${(doc.path || '').replace(/^\//, '')}`;
    const matchesTargetDoc = (s: Snapshot) => {
      const filesMap = s.files;
      return (
        filesMap.has(normalizedPath) ||
        (filesMap.size === 1 && filesMap.has('/main.tex'))
      );
    };

    const allSnaps = this.historyRepo
      ? await this.historyRepo.listVersions(doc.projectId)
      : [];
    const filtered = allSnaps
      .filter((s) => s.createdAt.getTime() <= targetTime.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const snap = filtered.find(matchesTargetDoc);

    if (!snap) {
      return { content: '', timestamp: targetTime.getTime(), found: false };
    }
    return {
      content: this.pickSnapshotText(
        snap.toFilesJson() as Record<string, unknown>,
        doc.path,
      ),
      timestamp: snap.createdAt.getTime(),
      versionId: snap.id,
      version: snap.version,
      found: true,
    };
  }

  // ─── 2. COMPILER INCREMENTAL SYNC ─────────────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/pages/:rootPageId/sync-incremental
   * POST /api/v1/manuscripts/docs/:rootPageId/sync-incremental
   * POST /api/v1/manuscripts/projects/:projectId/sync-incremental
   * POST /api/v1/manuscripts/projects/:projectId/docs/:rootPageId/sync-incremental
   */
  @Post([
    'pages/:rootPageId/sync-incremental',
    'docs/:rootPageId/sync-incremental',
    'projects/:projectId/sync-incremental',
    'projects/:projectId/docs/:rootPageId/sync-incremental',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async syncIncremental(
    @Param('rootPageId') rootPageId: string,
    @Body() body: { dirtyFileIds?: string[]; forceAll?: boolean },
    @Param('projectId') routeProjectId?: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    const effectiveTargetId = rootPageId || routeProjectId;
    if (!effectiveTargetId || !isUuid(effectiveTargetId)) {
      throw new BadRequestException('A valid UUID is required for sync-incremental');
    }
    const activeProjectId = this.resolveActiveProjectId(project) || routeProjectId;
    const doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, effectiveTargetId)
      : null;
    const projectId =
      doc?.projectId ||
      activeProjectId ||
      (await this.pageService.resolveProjectId(effectiveTargetId));
    if (!projectId) {
      throw new NotFoundException(`Document/project ${effectiveTargetId} not found`);
    }

    const requested = (body?.dirtyFileIds || []).filter((id) => isUuid(id));
    const allDocs = await this.docstoreService.getAllDocs(projectId);
    const docs = body?.forceAll
      ? allDocs
      : allDocs.filter((d) => requested.includes(d.id || d._id));
    const docIds = docs.map((d) => d.id || d._id);

    // Persist any in-memory Yjs edits so the compiler reads the latest text.
    const live = this.getLiveCollaboration();
    const flushedLive = live ? await live.flushDocs(projectId, docIds) : [];

    if (this.eventEmitter) {
      this.eventEmitter.emit('manuscripts.project.event', {
        projectId,
        event: 'compiler:sync',
        payload: {
          rootPageId,
          dirtyFileIds: docIds,
          timestamp: Date.now(),
        },
      });
    }

    return {
      synced: docIds,
      total: docIds.length,
      rootPageId,
      projectId,
      flushedLiveSessions: flushedLive,
      rejected: requested.filter((id) => !docIds.includes(id)),
    };
  }

  // ─── 3. DOCUMENT EXPORT ──────────────────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/pages/:pageId/export
   * GET /api/v1/manuscripts/docs/:pageId/export
   */
  @Get(['pages/:pageId/export', 'docs/:pageId/export'])
  async exportPage(
    @Param('pageId') pageId: string,
    @Query('format') format?: string,
    @Query('includeChildren') includeChildren?: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    return this.exportDocument(
      pageId,
      {
        format,
        includeChildren:
          includeChildren !== undefined
            ? includeChildren === 'true' || includeChildren === '1'
            : undefined,
      },
      undefined,
      undefined,
      project,
    );
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/export
   * POST /api/v1/manuscripts/docs/:pageId/export
   */
  @Post(['pages/:pageId/export', 'docs/:pageId/export'])
  @HttpCode(HttpStatus.OK)
  async exportDocument(
    @Param('pageId') pageId: string,
    @Body()
    body?: { format?: string; includeChildren?: boolean | string },
    @Query('format') queryFormat?: string,
    @Query('includeChildren') queryIncludeChildren?: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const activeProjectId = this.resolveActiveProjectId(project);
    let doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;
    if (!doc || doc.deleted) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const live = this.getLiveCollaboration();
    if (live && doc.projectId) {
      const flushed = await live.flushDocs(doc.projectId, []).catch(() => []);
      if (flushed.length > 0) {
        doc =
          (await this.pageScopeRepo.findDocInProject(doc.projectId, pageId)) ||
          doc;
      }
    }

    const format = (body?.format || queryFormat || 'tex').toLowerCase();
    const rawFilename = doc.path?.replace(/^\//, '') || 'document.tex';
    const hydratedLines = await this.getHydratedDocLines(doc);
    let content = hydratedLines.join('\n');

    const rawIncludeFlag = body?.includeChildren ?? queryIncludeChildren;
    const explicitExclude =
      rawIncludeFlag === false ||
      rawIncludeFlag === 'false' ||
      rawIncludeFlag === '0';
    const explicitInclude =
      rawIncludeFlag === true ||
      rawIncludeFlag === 'true' ||
      rawIncludeFlag === '1';
    const hasIncludeMacros = /\\(input|include|subfile)\s*\{[^}]+\}/.test(
      content,
    );

    if (
      doc.projectId &&
      !explicitExclude &&
      (explicitInclude || hasIncludeMacros)
    ) {
      try {
        const projectDocs = await this.docstoreService.getAllDocs(doc.projectId);
        if (projectDocs.length > 0) {
          const hydratedProjectDocs = await Promise.all(
            projectDocs.map(async (pd) => ({
              id: pd.id || pd._id,
              path: pd.path,
              lines: await this.getHydratedDocLines({
                id: pd.id || pd._id,
                projectId: pd.projectId || doc.projectId,
                lines: pd.lines,
                inStorage: pd.inStorage,
              }),
            })),
          );
          const rootKey = rawFilename.toLowerCase();
          content = resolveIncludedLatexContent(
            content,
            hydratedProjectDocs,
            new Set([rootKey, rootKey.replace(/\.tex$/i, '')]),
          );
        }
      } catch {
        // Fallback to unexpanded content if child doc query fails
      }
    }

    if (!this.exportImportService) {
      throw new InternalServerErrorException(
        'ExportImportService not initialized',
      );
    }

    return this.exportImportService.exportDocumentFormat({
      rawFilename,
      content,
      format,
    });
  }

  /**
   * POST /api/v1/manuscripts/projects/:projectId/updater/flush
   * Lightweight Yjs flush barrier endpoint for compatibility with pre-compile flush callers.
   */
  @Post('projects/:projectId/updater/flush')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async flushProject(@Param('projectId') projectId: string) {
    const startedAt = Date.now();
    const live = this.getLiveCollaboration();
    const flushed = live ? await live.flushDocs(projectId, []) : [];
    return {
      projectId,
      flushedDocs: flushed.length,
      flushedDocsCount: flushed.length,
      flushedDocIds: flushed,
      docIds: flushed,
      skippedDocIds: [],
      errors: [],
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
    };
  }
}
