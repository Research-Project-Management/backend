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
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
} from '@/modules/project/access';
import { Prisma, ManuscriptSnapshot } from '@prisma/client';
import { PrismaService, AuthenticatedRequest, isUuid } from '@/core';
import { createHash } from 'crypto';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptUserResolverService } from '../services/manuscript-user-resolver.service';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import {
  convertLatexToDocxBuffer,
  convertLatexToHtml,
  convertLatexToMarkdown,
  resolveIncludedLatexContent,
} from '@/modules/manuscripts/export-import/domain';
import {
  computeLineDiff,
  FileSnapshotVo,
  SnapshotNormalizer,
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
    private readonly prisma: PrismaService,
    private readonly pageScopeRepo: ManuscriptPageScopeRepository,
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
    const mainHit =
      filesMap.get('/main.tex') ?? filesMap.values().next().value;
    return mainHit?.lines ? mainHit.lines.join('\n') : '';
  }

  private resolveActiveProjectId(
    project?: string | { id: string } | null,
  ): string | undefined {
    if (!project) return undefined;
    return typeof project === 'string' ? project : project.id;
  }

  private async getHydratedDocLines(doc: {
    id: string;
    projectId: string;
    lines: unknown;
    inStorage?: boolean;
  }): Promise<string[]> {
    if (doc.inStorage) {
      try {
        const hydrated = await this.docstoreService.getDoc(
          doc.projectId,
          doc.id,
        );
        if (Array.isArray(hydrated.lines)) {
          return hydrated.lines;
        }
      } catch {
        // Fallback to raw lines if hydration fails
      }
    }
    if (Array.isArray(doc.lines)) {
      return doc.lines as string[];
    }
    if (typeof doc.lines === 'string') {
      return doc.lines.split('\n');
    }
    return [];
  }

  // ─── 1. VERSION HISTORY & SNAPSHOTS ──────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/versions
   */
  @Get('docs/:pageId/versions')
  async getVersions(
    @Param('pageId') pageId: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { versions: [] };
    try {
      const activeProjectId = this.resolveActiveProjectId(project);
    if (activeProjectId) {
        await this.getLiveCollaboration()?.flushDoc(activeProjectId, pageId).catch(() => []);
      }
      const doc = activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: { projectId: true },
          });
      const projectId = doc?.projectId || activeProjectId;
      if (!projectId || !isUuid(projectId)) return { versions: [] };

      const snapshots = await this.prisma.manuscriptSnapshot.findMany({
        where: { projectId },
        select: {
          id: true,
          version: true,
          summary: true,
          createdById: true,
          createdAt: true,
          labels: true,
        },
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
   * GET /api/v1/manuscripts/docs/:pageId/diff
   */
  @Get(['docs/:pageId/versions/diff', 'docs/:pageId/diff'])
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
        : await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: {
              id: true,
              path: true,
              lines: true,
              projectId: true,
              inStorage: true,
            },
          })
      : null;

    const targetProjectId = activeProjectId || doc?.projectId;
    if (!targetProjectId) {
      throw new NotFoundException(`Document or project context not found`);
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

    const currentLines = doc ? await this.getHydratedDocLines(doc) : [];
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
   */
  @Get('docs/:pageId/versions/:versionId')
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
          : this.prisma.manuscriptSnapshot.findUnique({
              where: { id: versionId },
              include: { labels: true },
            }),
        isUuid(pageId)
          ? activeProjectId
            ? this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
            : this.prisma.manuscriptDoc.findUnique({
                where: { id: pageId },
                select: { path: true, projectId: true },
              })
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
          label:
            s.labels?.[0]?.label ||
            s.summary ||
            `Version ${s.version}`,
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
   */
  @Post('docs/:pageId/versions')
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
      const doc = projectId
        ? await this.pageScopeRepo.findDocInProject(projectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: {
              id: true,
              projectId: true,
              path: true,
              lines: true,
              inStorage: true,
            },
          });
      projectId = doc?.projectId || projectId;
      if (doc?.path) docPath = doc.path.replace(/^\//, '') || docPath;
      if (doc) {
        const docLines = await this.getHydratedDocLines(doc);
        currentContent = docLines.join('\n');
      }
    }

    if (!projectId || !isUuid(projectId)) {
      throw new NotFoundException(`Project not found for doc ${pageId}`);
    }

    const content =
      typeof body.content === 'string' ? body.content : currentContent;

    try {
      const [aggOrCount, allDocs, userMap] = await Promise.all([
        this.prisma.manuscriptSnapshot.aggregate({
          where: { projectId },
          _max: { version: true },
        }),
        this.prisma.manuscriptDoc.findMany({
          where: { projectId, deleted: false },
          select: { id: true, projectId: true, path: true, lines: true, inStorage: true },
        }),
        this.resolveUserNames([userId]),
      ]);
      const nextVersion = (aggOrCount?._max?.version ?? 0) + 1;

      const snapshotFiles: Record<string, Record<string, unknown>> = {};
      let addedTargetDoc = false;
      for (const d of allDocs) {
        const cleanPath = (d.path || '').replace(/^\//, '') || 'main.tex';
        const normalizedPath = `/${cleanPath}`;
        let finalText: string;
        if (d.id === pageId) {
          finalText = content;
        } else {
          const dLines = await this.getHydratedDocLines({
            id: d.id,
            projectId: d.projectId || projectId,
            lines: d.lines,
            inStorage: d.inStorage,
          });
          finalText = dLines.join('\n');
        }
        if (d.id === pageId || cleanPath === docPath) {
          addedTargetDoc = true;
        }
        const vo = FileSnapshotVo.createDoc(
          normalizedPath,
          d.id,
          finalText.split('\n'),
          createHash('sha256').update(finalText).digest('hex'),
          normalizedPath === '/main.tex',
        );
        snapshotFiles[vo.path] = vo.toJSON();
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
        snapshotFiles[vo.path] = vo.toJSON();
      }

      const resolvedUser = userId ? userMap.get(userId) : undefined;
      const authorName =
        resolvedUser?.name ||
        req?.user?.name ||
        req?.user?.email?.split('@')[0] ||
        'Collaborator';

      let candidateVersion = nextVersion;
      const maxAttempts = 3;
      let snap: ManuscriptSnapshot | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          snap = await this.prisma.manuscriptSnapshot.create({
            data: {
              projectId,
              version: candidateVersion,
              summary: body.label || 'Manual Snapshot',
              createdById: isUuid(userId) ? userId : null,
              files: snapshotFiles as Prisma.InputJsonValue,
            },
          });
          break;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'P2002' && attempt < maxAttempts - 1) {
            const latest = await this.prisma.manuscriptSnapshot.aggregate({
              where: { projectId },
              _max: { version: true },
            });
            candidateVersion = Math.max(candidateVersion + 1, (latest?._max?.version ?? 0) + 1);
            continue;
          }
          throw err;
        }
      }
      if (!snap) {
        throw new InternalServerErrorException('Failed to create snapshot version');
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
   * POST /api/v1/manuscripts/docs/:pageId/versions/:versionId/restore
   */
  @Post('docs/:pageId/versions/:versionId/restore')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    if (!isUuid(versionId)) throw new BadRequestException('Invalid version ID');
    const activeProjectId = this.resolveActiveProjectId(project);
    const snap = activeProjectId
      ? await this.pageScopeRepo.findSnapshotInProject(
          activeProjectId,
          versionId,
        )
      : await this.prisma.manuscriptSnapshot.findUnique({
          where: { id: versionId },
        });
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const files = (snap.files as Record<string, unknown>) || {};
    const doc = isUuid(pageId)
      ? activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({ where: { id: pageId } })
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
   */
  @Post('docs/:pageId/versions/:versionId/label')
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
      : await this.prisma.manuscriptSnapshot.findUnique({
          where: { id: versionId },
        });
    if (!snap) throw new NotFoundException(`Snapshot ${versionId} not found`);

    const userId = req?.user?.id || req?.user?.sub || null;

    await this.prisma.manuscriptLabel.upsert({
      where: {
        projectId_label: {
          projectId: snap.projectId,
          label: labelName,
        },
      },
      create: {
        projectId: snap.projectId,
        snapshotId: versionId,
        version: snap.version,
        label: labelName,
        createdById: isUuid(userId) ? userId : null,
      },
      update: {
        snapshotId: versionId,
        version: snap.version,
        createdById: isUuid(userId) ? userId : null,
      },
    });

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
   */
  @Get('docs/:pageId/timeline')
  async getTimeline(
    @Param('pageId') pageId: string,
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    let projectId: string | undefined = this.resolveActiveProjectId(project);
    if (isUuid(pageId)) {
      const doc = projectId
        ? await this.pageScopeRepo.findDocInProject(projectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: { projectId: true },
          });
      projectId = doc?.projectId || projectId;
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
      select: {
        id: true,
        version: true,
        summary: true,
        createdById: true,
        createdAt: true,
        labels: true,
      },
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
   */
  @Get('docs/:pageId/at')
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
    const doc = isUuid(pageId)
      ? activeProjectId
        ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({
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
    const normalizedPath = `/${(doc.path || '').replace(/^\//, '')}`;
    const snap = snaps.find((s) => {
      const files = s.files as Record<string, unknown> | null;
      if (!files || Object.keys(files).length === 0) return false;
      const filesMap = SnapshotNormalizer.parseSnapshotFiles(files);
      return (
        filesMap.has(normalizedPath) ||
        (filesMap.size === 1 && filesMap.has('/main.tex'))
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


  // ─── 2. COMPILER INCREMENTAL SYNC ─────────────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/docs/:rootPageId/sync-incremental
   */
  @Post('docs/:rootPageId/sync-incremental')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async syncIncremental(
    @Param('rootPageId') rootPageId: string,
    @Body() body: { dirtyFileIds?: string[]; forceAll?: boolean },
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    if (!isUuid(rootPageId)) {
      throw new BadRequestException('A valid UUID is required for rootPageId');
    }
    const activeProjectId = this.resolveActiveProjectId(project);
    const doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, rootPageId)
      : null;
    const projectId =
      doc?.projectId ||
      activeProjectId ||
      (await this.resolveProjectId(rootPageId));
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
   */
  @Get('docs/:pageId/export')
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
   * POST /api/v1/manuscripts/docs/:pageId/export
   */
  @Post('docs/:pageId/export')
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
    const doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });
    if (!doc || doc.deleted) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const format = (body?.format || queryFormat || 'tex').toLowerCase();
    const rawFilename = doc.path?.replace(/^\//, '') || 'document.tex';
    const baseName = rawFilename.replace(/\.[^/.]+$/, '');
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
        const projectDocs = await this.prisma.manuscriptDoc.findMany({
          where: { projectId: doc.projectId, deleted: false },
          select: {
            id: true,
            projectId: true,
            path: true,
            lines: true,
            inStorage: true,
          },
        });
        if (projectDocs.length > 0) {
          const hydratedProjectDocs = await Promise.all(
            projectDocs.map(async (pd) => ({
              id: pd.id,
              path: pd.path,
              lines: await this.getHydratedDocLines({
                id: pd.id,
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

    if (format === 'docx') {
      const docxBuffer = convertLatexToDocxBuffer(content, baseName);
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
      const mdContent = convertLatexToMarkdown(content, baseName);
      return {
        filename: `${baseName}.md`,
        mimeType: 'text/markdown',
        content: mdContent,
        isBase64: false,
        sizeBytes: Buffer.byteLength(mdContent, 'utf8'),
      };
    }

    if (format === 'html') {
      const htmlContent = convertLatexToHtml(content, baseName);
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
