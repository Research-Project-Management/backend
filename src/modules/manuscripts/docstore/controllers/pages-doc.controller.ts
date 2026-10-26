/**
 * modules/manuscripts/docstore/controllers/pages-doc.controller.ts
 * Domain-focused controller handling Document CRUD, Files, Trash/Restore,
 * Duplicate/Clone, Project Pages, and Labels.
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
} from '@/modules/project/access';
import { PrismaService, AuthenticatedRequest, isUuid } from '@/core';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptProjectBootstrapService } from '../services/manuscript-project-bootstrap.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';
import {
  PageDocRanges,
  resolveActiveProjectId,
  resolveProjectIdByEntityId,
  hydratePageDocLines,
  findPageRecordWithNode,
  formatPageByIdResponse,
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
  applyPageMetadataAndTitleUpdates,
  updateProjectThumbnailSettings,
  resolvePageFilesList,
  formatRootNodesAsProjectPages,
  restoreDeletedDocOrFile,
  duplicateSourcePageAndNode,
  resolveAndAssignLabelsForDoc,
  isPrismaUniqueConstraintError,
} from './pages-doc.helpers';

export type { PageDocRanges };

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PagesDocController {
  private readonly logger = new Logger(PagesDocController.name);
  private liveCollab: LiveCollaborationPort | null | undefined;
  private readonly pageScopeRepo: ManuscriptPageScopeRepository;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly prisma: PrismaService,
    private readonly projectBootstrapService: ManuscriptProjectBootstrapService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() pageScopeRepo?: ManuscriptPageScopeRepository,
  ) {
    this.pageScopeRepo =
      pageScopeRepo || new ManuscriptPageScopeRepository(prisma);
  }

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

  private async resolveProjectId(id: string): Promise<string | null> {
    return resolveProjectIdByEntityId(this.prisma, id);
  }

  private resolveActiveProjectId(
    project?: string | { id: string } | null,
  ): string | undefined {
    return resolveActiveProjectId(project);
  }

  private async getHydratedDocLines(doc: {
    id: string;
    projectId: string;
    lines: unknown;
    inStorage?: boolean;
  }): Promise<string[]> {
    return hydratePageDocLines(this.docstoreService, doc);
  }

  // ─── 1. CORE DOCUMENT CONTENT & METADATA ──────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId
   */
  @Get('docs/:pageId')
  @ApiOperation({ summary: 'Get document by pageId from database' })
  async getPageById(
    @Param('pageId') pageId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    try {
      const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
      const record = await findPageRecordWithNode(
        this.prisma,
        pageId,
        targetProjectId,
      );

      if (!record || record.deleted) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const live = this.getLiveCollaboration();
      if (live && record.projectId) {
        const flushed = await live
          .flushDocs(record.projectId, [pageId])
          .catch(() => []);
        if (flushed.length > 0) {
          const refreshed = await findPageRecordWithNode(
            this.prisma,
            pageId,
            record.projectId,
          );
          if (refreshed && !refreshed.deleted) {
            return await formatPageByIdResponse(
              this.docstoreService,
              refreshed,
            );
          }
        }
      }

      return await formatPageByIdResponse(this.docstoreService, record);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException(`Document ${pageId} not found`);
    }
  }

  /**
   * PUT /api/v1/manuscripts/docs/:pageId
   */
  @Put('docs/:pageId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Update document content by pageId' })
  async updatePageContent(
    @Param('pageId') pageId: string,
    @Body()
    body: {
      content?: string;
      lines?: string[];
      title?: string;
      version?: number;
      expectedRev?: number;
      expectedVersion?: number;
      status?: 'draft' | 'published' | 'archived';
      description?: string;
    },
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    const record = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
      : await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });

    if (!record || record.deleted) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${pageId} not found`,
      });
    }

    assertExpectedVersionAndRev(record, body.expectedRev, body.expectedVersion);

    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';
    if (!hasNewContent && record.projectId) {
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(record.projectId, [pageId]).catch(() => []);
      }
    }
    const lines = hasNewContent
      ? body.lines ||
        (typeof body.content === 'string' ? body.content.split('\n') : [])
      : await this.getHydratedDocLines(record);

    const result = await executeDocstoreUpdateWithOcc(
      this.docstoreService,
      record,
      lines,
      body.version,
      body.expectedRev,
    );

    const liveSynced = hasNewContent
      ? await this.syncLiveDoc(record.projectId, pageId, lines)
      : false;

    const { cleanTitle, existingRanges } =
      await applyPageMetadataAndTitleUpdates(this.prisma, pageId, record, body);

    const updatedLines = result.doc.lines || [];
    const content = Array.isArray(updatedLines)
      ? updatedLines.join('\n')
      : String(updatedLines);

    if (this.eventEmitter && record.projectId) {
      try {
        this.eventEmitter.emit('manuscripts.project.event', {
          projectId: record.projectId,
          event: 'doc:content-updated',
          payload: {
            docId: pageId,
            version: result.doc.version,
            rev: result.doc.rev,
            content,
            updatedAt: new Date().toISOString(),
          },
        });
      } catch {
        // Non-blocking real-time broadcast error ignored
      }
    }

    return {
      ...result,
      rev: result.rev,
      liveSessionSynced: liveSynced,
      page: {
        id: result.doc.id,
        title: cleanTitle || result.doc.path?.replace(/^\//, '') || 'main.tex',
        description: body.description ?? existingRanges.description ?? '',
        content,
        status: body.status || existingRanges.status || 'published',
        projectId: record.projectId,
        version: result.doc.version,
        rev: result.doc.rev,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * PUT /api/v1/manuscripts/docs/:pageId/thumbnail
   */
  @Put('docs/:pageId/thumbnail')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() body: { pdfThumbnail?: string },
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const pdfThumbnail = body?.pdfThumbnail || '';

    if (isUuid(pageId)) {
      try {
        const targetProjectId =
          this.resolveActiveProjectId(authorizedProjectId);
        const record = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
          : await this.prisma.manuscriptDoc.findUnique({
              where: { id: pageId },
              select: { id: true, projectId: true, ranges: true },
            });

        let projectId = record?.projectId || null;

        if (record) {
          const existingRanges = (record.ranges as PageDocRanges) || {};
          await this.prisma.manuscriptDoc
            .update({
              where: { id: pageId },
              data: {
                ranges: {
                  ...existingRanges,
                  pdfThumbnail,
                },
              },
            })
            .catch(() => null);
        } else {
          projectId = await this.resolveProjectId(pageId);
        }

        if (projectId) {
          await updateProjectThumbnailSettings(
            this.prisma,
            projectId,
            pdfThumbnail,
          );
        }
      } catch {
        // Non-blocking fallback
      }
    }

    return {
      page: {
        id: pageId,
        pdfThumbnail,
      },
    };
  }

  /**
   * GET /api/v1/manuscripts/docs/:pageId/files
   */
  @Get('docs/:pageId/files')
  async getPageFiles(@Param('pageId') pageId: string) {
    try {
      if (!isUuid(pageId)) {
        return { files: [] };
      }
      const live = this.getLiveCollaboration();
      if (live) {
        const resolvedProjectId = await this.resolveProjectId(pageId);
        if (resolvedProjectId) {
          await live.flushDocs(resolvedProjectId, []).catch(() => []);
        }
      }
      return await resolvePageFilesList(
        this.prisma,
        this.docstoreService,
        pageId,
      );
    } catch {
      return { files: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/files
   */
  @Post('docs/:pageId/files')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createPageFile(
    @Param('pageId') pageId: string,
    @Body() body: { title?: string; name?: string; content?: string },
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    const fileName = body?.title || body?.name || 'untitled.tex';
    const cleanName = fileName.trim().replace(/^\//, '');
    const content = body?.content || '';

    let projectId: string | null =
      this.resolveActiveProjectId(authorizedProjectId) || null;
    const parentDocId = pageId;

    if (!projectId && isUuid(pageId)) {
      const record = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });
      if (record) {
        projectId = record.projectId;
      } else {
        const project = await this.prisma.project.findUnique({
          where: { id: pageId },
        });
        if (project) {
          projectId = project.id;
        }
      }
    }

    if (!projectId) {
      throw new NotFoundException(
        `Project not found for document or page ${pageId}`,
      );
    }

    const cleanDocPath = cleanName.replace(/\\/g, '/').replace(/^\/+/g, '');
    const cleanNodePath = `/${cleanDocPath}`;

    const createdDoc = await this.docstoreService.createDoc(projectId, {
      path: cleanDocPath,
      text: content,
      version: 1,
    });

    let nodeId = createdDoc._id;
    try {
      const node = await this.prisma.manuscriptNode.create({
        data: {
          projectId,
          name: cleanName,
          path: cleanNodePath,
          type: 'DOC',
          docId: createdDoc._id,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
      });
      nodeId = node.id;
    } catch (createErr: unknown) {
      try {
        await this.docstoreService.patchDoc(projectId, createdDoc._id, {
          deleted: true,
          deletedAt: new Date().toISOString(),
        });
      } catch {
        // Ignore rollback failure
      }
      if (isPrismaUniqueConstraintError(createErr)) {
        throw new BadRequestException(
          `File path already exists: ${cleanNodePath}`,
        );
      }
      throw createErr;
    }

    return {
      file: {
        id: createdDoc._id,
        nodeId,
        title: cleanName,
        name: cleanName,
        path: `/${cleanName}`,
        type: 'file',
        pageId: parentDocId,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // ─── 2. PROJECT DOCS CRUD & LABELS ──────────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/projects/:projectId/docs
   */
  @Post('projects/:projectId/docs')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createProjectPage(
    @Param('projectId') projectId: string,
    @Body()
    body: {
      title?: string;
      content?: string;
      status?: string;
      labels?: string[];
      labelIds?: string[];
      templateType?: string;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.projectBootstrapService.createProjectPage(
      projectId,
      body,
      userId,
    );
  }

  /**
   * GET /api/v1/manuscripts/projects/:projectId/docs
   */
  @Get('projects/:projectId/docs')
  async getProjectPages(
    @Param('projectId') projectId: string,
    @Query('status') _status?: string,
    @Query('search') _search?: string,
  ) {
    if (!isUuid(projectId)) {
      return { pages: [], total: 0, isEmpty: true };
    }
    try {
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(projectId, []).catch(() => []);
      }
      const [rootNodes, project] = await Promise.all([
        this.prisma.manuscriptNode.findMany({
          where: {
            projectId,
            isRootDoc: true,
            OR: [{ docId: null }, { doc: { deleted: false } }],
          },
          include: { doc: true },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: {
            id: true,
            createdBy: {
              select: {
                id: true,
                email: true,
                profile: { select: { name: true } },
              },
            },
          },
        }),
      ]);

      const authorName =
        project?.createdBy?.profile?.name ||
        project?.createdBy?.email?.split('@')[0] ||
        'Author';

      const pages = await formatRootNodesAsProjectPages(
        this.docstoreService,
        projectId,
        authorName,
        rootNodes,
        _search,
      );

      return {
        pages,
        total: pages.length,
        isEmpty: pages.length === 0,
      };
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      this.logger.error(`Error fetching docs for project ${projectId}`, err);
      throw new InternalServerErrorException(
        'Failed to fetch project documents and pages',
      );
    }
  }

  /**
   * DELETE /api/v1/manuscripts/docs/:pageId
   */
  @Delete('docs/:pageId')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async deletePage(
    @Param('pageId') pageId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (isUuid(pageId)) {
      try {
        const targetProjectId =
          this.resolveActiveProjectId(authorizedProjectId);
        const doc = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
          : await this.prisma.manuscriptDoc.findUnique({
              where: { id: pageId },
            });
        if (doc) {
          const live = this.getLiveCollaboration();
          if (live) {
            await live.evictDoc(doc.projectId, doc.id).catch(() => null);
          }
          await Promise.all([
            this.docstoreService.patchDoc(doc.projectId, doc.id, {
              deleted: true,
              deletedAt: new Date().toISOString(),
            }),
            this.prisma.manuscriptNode
              .deleteMany({
                where: {
                  projectId: doc.projectId,
                  OR: [{ docId: doc.id }, { id: pageId }],
                },
              })
              .catch(() => null),
          ]);
        }
      } catch {
        // Fallback
      }
    }
    return { success: true };
  }

  /**
   * GET /api/v1/manuscripts/docs/:pageId/deleted-files
   */
  @Get('docs/:pageId/deleted-files')
  @ApiOperation({ summary: 'Get list of deleted/trashed files in project' })
  async getDeletedFiles(
    @Param('pageId') pageId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    let projectId: string | null =
      this.resolveActiveProjectId(authorizedProjectId) || null;
    if (!projectId && isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      if (doc) {
        projectId = doc.projectId;
      } else {
        const project = await this.prisma.project.findUnique({
          where: { id: pageId },
          select: { id: true },
        });
        if (project) projectId = project.id;
      }
    }

    if (!projectId) {
      return { files: [] };
    }

    const [deletedDocs, deletedFiles] = await Promise.all([
      this.prisma.manuscriptDoc.findMany({
        where: { projectId, deleted: true },
        select: {
          id: true,
          path: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      this.prisma.manuscriptFile.findMany({
        where: { projectId, deleted: true },
        select: {
          id: true,
          name: true,
          sizeBytes: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
    ]);

    const files = [
      ...deletedDocs.map((d) => ({
        id: d.id,
        pageId,
        title: d.path?.replace(/^\//, '') || 'document.tex',
        path: d.path,
        type: 'DOC',
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      ...deletedFiles.map((f) => ({
        id: f.id,
        pageId,
        title: f.name,
        path: `/${f.name}`,
        type: 'FILE',
        size: Number(f.sizeBytes || 0),
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    ];

    return { files };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/restore
   */
  @Post('docs/:pageId/restore')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a soft-deleted document or file' })
  async restorePage(
    @Param('pageId') pageId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    return restoreDeletedDocOrFile(
      this.prisma,
      this.docstoreService,
      this.eventEmitter,
      pageId,
      targetProjectId,
    );
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/duplicate
   * POST /api/v1/manuscripts/docs/:pageId/clone
   */
  @Post(['docs/:pageId/duplicate', 'docs/:pageId/clone'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Duplicate/clone a page by pageId with its content and tree node',
  })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    const source = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
      : await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });

    if (!source) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const live = this.getLiveCollaboration();
    if (live && source.projectId) {
      await live.flushDocs(source.projectId, [pageId]).catch(() => []);
    }

    const freshSource =
      (source.projectId
        ? await this.pageScopeRepo.findDocInProject(source.projectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
          })) || source;

    return duplicateSourcePageAndNode(
      this.prisma,
      this.docstoreService,
      this.eventEmitter,
      pageId,
      freshSource,
    );
  }

  /**
   * Label management routes
   */
  @Get('projects/:projectId/docs/:pageId/labels')
  async getPageLabels(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
  ) {
    if (isUuid(pageId)) {
      const doc = await this.pageScopeRepo.findDocInProject(projectId, pageId);
      const ranges = (
        doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
      ) as PageDocRanges;
      const labels = ranges.labels || [];
      return { labels };
    }
    return { labels: [] };
  }

  @Post('projects/:projectId/docs/:pageId/labels')
  @RequireRole(Role.CONTRIBUTOR)
  async assignPageLabels(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    if (isUuid(pageId) && Array.isArray(body?.labelIds)) {
      return resolveAndAssignLabelsForDoc(
        this.prisma,
        this.pageScopeRepo,
        projectId,
        pageId,
        body.labelIds,
      );
    }
    return { labels: [] };
  }

  @Put('projects/:projectId/docs/:pageId/labels')
  @RequireRole(Role.CONTRIBUTOR)
  async replacePageLabels(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    return this.assignPageLabels(projectId, pageId, body);
  }

  @Delete('projects/:projectId/docs/:pageId/labels/:labelId')
  @RequireRole(Role.CONTRIBUTOR)
  async removePageLabel(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Param('labelId') labelId: string,
  ) {
    if (isUuid(pageId)) {
      const doc = await this.pageScopeRepo.findDocInProject(projectId, pageId);
      if (!doc) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const ranges = (
        doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
      ) as PageDocRanges;
      const labels = (ranges.labels || []).filter((l) => l.id !== labelId);
      const labelIds = (ranges.labelIds || []).filter(
        (id: string) => id !== labelId,
      );
      await this.pageScopeRepo.updateDocInProject(projectId, pageId, {
        ranges: { labelIds, labels },
      });
      return { labels };
    }
    return { labels: [] };
  }
}
