/**
 * modules/manuscripts/docstore/controllers/pages-history-export.controller.ts
 * Domain-focused controller handling Version History, Diff, Timeline, Point-in-Time At,
 * Document Export, and Compiler Incremental Sync routes.
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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { PrismaService, AuthenticatedRequest } from '@/core';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { PageExportTranspilerService } from '../services/page-export-transpiler.service';
import { ManuscriptUserResolverService } from '../services/manuscript-user-resolver.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '../core/ports/live-collaboration.port';
import { computeLineDiff } from '../core/domain/line-diff';

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@ApiTags('Manuscripts - Pages History & Export')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/manuscripts', 'v1/manuscripts', 'manuscripts', 'api'])
@UseGuards(JwtAuthGuard)
export class PagesHistoryExportController {
  private readonly logger = new Logger(PagesHistoryExportController.name);
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly prisma: PrismaService,
    private readonly pageExportTranspiler: PageExportTranspilerService,
    private readonly userResolver: ManuscriptUserResolverService,
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

  private async resolveProjectId(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id },
      select: { projectId: true },
    });
    if (doc?.projectId) return doc.projectId;
    const node = await this.prisma.manuscriptNode.findFirst({
      where: { projectId: id },
      select: { projectId: true },
    });
    return node?.projectId ?? null;
  }

  /** Extracts raw text from a snapshot file entry (string or structured FileSnapshotVo/CLSI object). */
  private extractSnapshotEntryText(entry: unknown): string | null {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as {
        lines?: unknown;
        content?: unknown;
        textContent?: unknown;
      };
      if (Array.isArray(obj.lines)) {
        return obj.lines.map((l) => String(l ?? '')).join('\n');
      }
      if (typeof obj.textContent === 'string') return obj.textContent;
      if (typeof obj.content === 'string') return obj.content;
    }
    return null;
  }

  /** Selects the snapshot entry for a doc path (handles leading-slash variants and structured/legacy shapes). */
  private pickSnapshotText(
    files: Record<string, unknown>,
    docPath?: string | null,
  ): string {
    const fileKeys = Object.keys(files).filter((k) => !k.startsWith('__'));
    if (docPath) {
      const bare = docPath.replace(/^\//, '');
      const hit = files[docPath] ?? files[bare] ?? files[`/${bare}`];
      const extracted = this.extractSnapshotEntryText(hit);
      if (extracted !== null) return extracted;
      if (
        fileKeys.length === 1 &&
        (fileKeys[0] === 'main.tex' || fileKeys[0] === '/main.tex')
      ) {
        return this.extractSnapshotEntryText(files[fileKeys[0]]) ?? '';
      }
      return '';
    }
    const mainHit =
      files['main.tex'] ??
      files['/main.tex'] ??
      (fileKeys.length > 0 ? files[fileKeys[0]] : undefined);
    return this.extractSnapshotEntryText(mainHit) ?? '';
  }

  // ─── 1. VERSION HISTORY & SNAPSHOTS ──────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/versions
   * GET /api/pages/:pageId/versions
   */
  @Get(['docs/:pageId/versions', 'pages/:pageId/versions'])
  async getVersions(@Param('pageId') pageId: string) {
    if (!isUuid(pageId)) return { versions: [] };
    try {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      const projectId = doc?.projectId;
      if (!projectId || !isUuid(projectId)) return { versions: [] };

      const snapshots = await this.prisma.manuscriptSnapshot.findMany({
        where: { projectId },
        include: { labels: true },
        orderBy: { version: 'desc' },
        take: 500,
      });

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
   * GET /api/v1/manuscripts/docs/:pageId/versions/diff
   * GET /api/pages/:pageId/versions/diff
   * GET /api/v1/manuscripts/docs/:pageId/diff
   * GET /api/pages/:pageId/diff
   */
  @Get([
    'docs/:pageId/versions/diff',
    'pages/:pageId/versions/diff',
    'docs/:pageId/diff',
    'pages/:pageId/diff',
  ])
  async getDiff(
    @Param('pageId') pageId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const doc = isUuid(pageId)
      ? await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          select: { id: true, path: true, lines: true, projectId: true },
        })
      : null;

    const loadSnap = async (id: string) => {
      if (!isUuid(id)) return null;
      const snap = await this.prisma.manuscriptSnapshot.findUnique({
        where: { id },
      });
      if (!snap) {
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

    const currentText = doc
      ? Array.isArray(doc.lines)
        ? (doc.lines as string[]).join('\n')
        : String(doc.lines ?? '')
      : '';
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
        lines: h.lines,
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
   * GET /api/v1/manuscripts/docs/:pageId/versions/:versionId
   * GET /api/pages/:pageId/versions/:versionId
   */
  @Get([
    'docs/:pageId/versions/:versionId',
    'pages/:pageId/versions/:versionId',
  ])
  async getVersionById(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    if (!isUuid(versionId)) return { version: null };
    try {
      const [s, doc] = await Promise.all([
        this.prisma.manuscriptSnapshot.findUnique({
          where: { id: versionId },
          include: { labels: true },
        }),
        isUuid(pageId)
          ? this.prisma.manuscriptDoc.findUnique({
              where: { id: pageId },
              select: { path: true },
            })
          : Promise.resolve(null),
      ]);
      if (!s) return { version: null };

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
   * POST /api/v1/manuscripts/docs/:pageId/versions
   * POST /api/pages/:pageId/versions
   */
  @Post(['docs/:pageId/versions', 'pages/:pageId/versions'])
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('pageId') pageId: string,
    @Body() body: { label?: string; content?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | undefined;
    let docPath = 'main.tex';
    let currentContent = '';
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true, path: true, lines: true },
      });
      projectId = doc?.projectId;
      if (doc?.path) docPath = doc.path.replace(/^\//, '') || docPath;
      currentContent = Array.isArray(doc?.lines)
        ? (doc.lines as string[]).join('\n')
        : String(doc?.lines ?? '');
    }

    if (!projectId || !isUuid(projectId)) {
      throw new NotFoundException(`Project not found for doc ${pageId}`);
    }

    const content =
      typeof body.content === 'string' ? body.content : currentContent;

    try {
      const [count, allDocs, userMap] = await Promise.all([
        this.prisma.manuscriptSnapshot.count({
          where: { projectId },
        }),
        this.prisma.manuscriptDoc.findMany({
          where: { projectId, deleted: false },
          select: { id: true, path: true, lines: true },
        }),
        this.resolveUserNames([userId]),
      ]);

      const snapshotFiles: Record<string, string> = {};
      for (const d of allDocs) {
        const cleanPath = (d.path || '').replace(/^\//, '') || 'main.tex';
        const dText = Array.isArray(d.lines)
          ? (d.lines as string[]).join('\n')
          : String(d.lines ?? '');
        snapshotFiles[cleanPath] = d.id === pageId ? content : dText;
      }
      snapshotFiles[docPath] = content;

      const resolvedUser = userId ? userMap.get(userId) : undefined;
      const authorName =
        resolvedUser?.name ||
        req?.user?.name ||
        req?.user?.email?.split('@')[0] ||
        'Collaborator';

      const snap = await this.prisma.manuscriptSnapshot.create({
        data: {
          projectId,
          version: count + 1,
          summary: body.label || 'Manual Snapshot',
          createdById: isUuid(userId) ? userId : null,
          files: snapshotFiles,
        },
      });
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
   * POST /api/v1/manuscripts/docs/:pageId/versions/:versionId/restore
   * POST /api/pages/:pageId/versions/:versionId/restore
   */
  @Post([
    'docs/:pageId/versions/:versionId/restore',
    'pages/:pageId/versions/:versionId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');
    const snap = await this.prisma.manuscriptSnapshot.findUnique({
      where: { id: versionId },
    });
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const files = (snap.files as Record<string, unknown>) || {};
    const doc = isUuid(pageId)
      ? await this.prisma.manuscriptDoc.findUnique({ where: { id: pageId } })
      : null;

    if (doc) {
      if (snap.projectId !== doc.projectId) {
        throw new BadRequestException(
          'Version does not belong to this document project',
        );
      }
      const restoredText = this.pickSnapshotText(files, doc.path);
      const lines = restoredText.split('\n');
      await this.docstoreService.updateDoc(doc.projectId, doc.id, {
        lines,
        version: doc.version + 1,
      });
      const liveSessionSynced = await this.syncLiveDoc(
        doc.projectId,
        doc.id,
        lines,
      );
      return {
        success: true,
        restoredVersion: snap.version,
        liveSessionSynced,
      };
    }
    throw new NotFoundException(`Document ${pageId} not found`);
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/versions/:versionId/label
   * POST /api/pages/:pageId/versions/:versionId/label
   */
  @Post([
    'docs/:pageId/versions/:versionId/label',
    'pages/:pageId/versions/:versionId/label',
  ])
  @HttpCode(HttpStatus.OK)
  async labelVersion(
    @Param('versionId') versionId: string,
    @Body() body: { label: string; title?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const labelName = body?.label?.trim();
    if (!labelName) throw new BadRequestException('Label cannot be empty');
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');

    const snap = await this.prisma.manuscriptSnapshot.findUnique({
      where: { id: versionId },
    });
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const userId = req?.user?.id || req?.user?.sub || null;

    await this.prisma.manuscriptLabel
      .create({
        data: {
          projectId: snap.projectId,
          snapshotId: versionId,
          version: snap.version,
          label: labelName,
          createdById: isUuid(userId) ? userId : null,
        },
      })
      .catch(() => {});

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
   * GET /api/v1/manuscripts/docs/:pageId/timeline
   * GET /api/pages/:pageId/timeline
   */
  @Get(['docs/:pageId/timeline', 'pages/:pageId/timeline'])
  async getTimeline(@Param('pageId') pageId: string) {
    let projectId: string | undefined;
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      projectId = doc?.projectId;
    }

    if (!projectId || !isUuid(projectId)) {
      return {
        entries: [],
        oldestMs: Date.now() - 3600000,
        newestMs: Date.now(),
      };
    }

    const snapshots = await this.prisma.manuscriptSnapshot.findMany({
      where: { projectId },
      include: { labels: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const userMap = await this.resolveUserNames(
      snapshots.map((s) => s.createdById),
    );

    const entries = snapshots.map((s) => {
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

  /**
   * GET /api/v1/manuscripts/docs/:pageId/at
   * GET /api/pages/:pageId/at
   */
  @Get(['docs/:pageId/at', 'pages/:pageId/at'])
  async getAt(
    @Param('pageId') pageId: string,
    @Query('timestamp') timestamp?: string,
  ) {
    let targetTime = timestamp
      ? new Date(Number(timestamp) || timestamp)
      : new Date();
    if (isNaN(targetTime.getTime())) targetTime = new Date();

    const doc = isUuid(pageId)
      ? await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          select: { projectId: true, path: true },
        })
      : null;
    if (!doc) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const snaps = await this.prisma.manuscriptSnapshot.findMany({
      where: { projectId: doc.projectId, createdAt: { lte: targetTime } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const bare = (doc.path || '').replace(/^\//, '');
    const snap = snaps.find((s) => {
      const files = (s.files as Record<string, unknown>) || {};
      const fileKeys = Object.keys(files).filter((k) => !k.startsWith('__'));
      return (
        bare in files ||
        `/${bare}` in files ||
        (('main.tex' in files || '/main.tex' in files) && fileKeys.length === 1)
      );
    });

    if (!snap) {
      return { content: '', timestamp: targetTime.getTime(), found: false };
    }
    return {
      content: this.pickSnapshotText(
        (snap.files as Record<string, unknown>) || {},
        doc.path,
      ),
      timestamp: snap.createdAt.getTime(),
      versionId: snap.id,
      version: snap.version,
      found: true,
    };
  }

  /**
   * GET /api/v1/manuscripts/projects/:projectId/history
   * GET /api/pages/:projectId/history
   */
  @Get(['projects/:projectId/history', 'pages/:projectId/history'])
  async getProjectHistory(@Param('projectId') projectId: string) {
    if (!isUuid(projectId)) return { events: [], history: [] };

    const snapshots = await this.prisma.manuscriptSnapshot.findMany({
      where: { projectId },
      include: { labels: true },
      orderBy: { version: 'desc' },
      take: 100,
    });

    const events = snapshots.map((s) => ({
      id: s.id,
      version: s.version,
      label: s.labels?.[0]?.label || s.summary || `Version ${s.version}`,
      createdAt: s.createdAt.toISOString(),
      userId: s.createdById || 'anonymous',
      summary: s.summary,
    }));

    return { events, history: events };
  }

  // ─── 2. COMPILER INCREMENTAL SYNC ─────────────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/docs/:rootPageId/sync-incremental
   * POST /api/pages/:rootPageId/sync-incremental
   */
  @Post([
    'docs/:rootPageId/sync-incremental',
    'pages/:rootPageId/sync-incremental',
  ])
  @HttpCode(HttpStatus.OK)
  async syncIncremental(
    @Param('rootPageId') rootPageId: string,
    @Body() body: { dirtyFileIds?: string[]; forceAll?: boolean },
  ) {
    if (!isUuid(rootPageId)) {
      throw new BadRequestException('A valid UUID is required for rootPageId');
    }
    const projectId = await this.resolveProjectId(rootPageId);
    if (!projectId) {
      throw new NotFoundException(`Document/project ${rootPageId} not found`);
    }

    // Only accept doc ids that really belong to this project.
    const requested = (body?.dirtyFileIds || []).filter((id) => isUuid(id));
    const docs = await this.prisma.manuscriptDoc.findMany({
      where: body?.forceAll
        ? { projectId, deleted: false }
        : { projectId, deleted: false, id: { in: requested } },
      select: { id: true, version: true },
    });
    const docIds = docs.map((d) => d.id);

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
   * GET /api/v1/manuscripts/docs/:pageId/export
   * GET /api/pages/:pageId/export
   */
  @Get(['docs/:pageId/export', 'pages/:pageId/export'])
  async exportPage(
    @Param('pageId') pageId: string,
    @Query('format') format?: string,
    @Query('includeChildren') includeChildren?: string,
  ) {
    return this.exportDocument(pageId, {
      format,
      includeChildren:
        includeChildren !== undefined
          ? includeChildren === 'true' || includeChildren === '1'
          : undefined,
    });
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/export
   * POST /api/pages/:pageId/export
   */
  @Post(['docs/:pageId/export', 'pages/:pageId/export'])
  @HttpCode(HttpStatus.OK)
  async exportDocument(
    @Param('pageId') pageId: string,
    @Body()
    body?: { format?: string; includeChildren?: boolean | string },
    @Query('format') queryFormat?: string,
    @Query('includeChildren') queryIncludeChildren?: string,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
    });
    if (!doc || doc.deleted) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const format = (body?.format || queryFormat || 'tex').toLowerCase();
    const rawFilename = doc.path?.replace(/^\//, '') || 'document.tex';
    const baseName = rawFilename.replace(/\.[^/.]+$/, '');
    const lines = doc.lines as string[] | undefined;
    let content = Array.isArray(lines)
      ? lines.join('\n')
      : typeof doc.lines === 'string'
        ? doc.lines
        : '';

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
        const projectDocs = await this.prisma.manuscriptDoc.findMany({
          where: { projectId: doc.projectId, deleted: false },
          select: { id: true, path: true, lines: true },
        });
        if (projectDocs.length > 0) {
          const rootKey = rawFilename.toLowerCase();
          content = this.pageExportTranspiler.resolveIncludedLatexContent(
            content,
            projectDocs,
            new Set([rootKey, rootKey.replace(/\.tex$/i, '')]),
          );
        }
      } catch {
        // Fallback to unexpanded content if child doc query fails
      }
    }

    if (format === 'docx') {
      const docxBuffer = this.pageExportTranspiler.convertLatexToDocxBuffer(
        content,
        baseName,
      );
      return {
        filename: `${baseName}.docx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: docxBuffer.toString('base64'),
        isBase64: true,
        sizeBytes: docxBuffer.length,
      };
    }

    if (format === 'md' || format === 'markdown') {
      const mdContent = this.pageExportTranspiler.convertLatexToMarkdown(
        content,
        baseName,
      );
      return {
        filename: `${baseName}.md`,
        mimeType: 'text/markdown',
        content: mdContent,
        isBase64: false,
        sizeBytes: Buffer.byteLength(mdContent, 'utf8'),
      };
    }

    if (format === 'html') {
      const htmlContent = this.pageExportTranspiler.convertLatexToHtml(
        content,
        baseName,
      );
      return {
        filename: `${baseName}.html`,
        mimeType: 'text/html',
        content: htmlContent,
        isBase64: false,
        sizeBytes: Buffer.byteLength(htmlContent, 'utf8'),
      };
    }

    return {
      filename: rawFilename,
      mimeType: 'application/x-tex',
      content,
      isBase64: false,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };
  }
}
