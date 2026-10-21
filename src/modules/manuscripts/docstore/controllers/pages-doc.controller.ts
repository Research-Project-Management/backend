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
import { ManuscriptDoc } from '@prisma/client';
import { PrismaService, AuthenticatedRequest, isUuid } from '@/core';
import * as path from 'path';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptProjectBootstrapService } from '../services/manuscript-project-bootstrap.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';

export interface PageDocRanges {
  labels?: Array<{ id: string; name?: string; color?: string }>;
  labelIds?: string[];
  status?: string;
  description?: string;
  pdfThumbnail?: string;
  [key: string]: unknown;
}

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
      let record = null;
      const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);

      if (targetProjectId) {
        if (isUuid(pageId)) {
          record = await this.prisma.manuscriptDoc.findFirst({
            where: {
              projectId: targetProjectId,
              deleted: false,
              OR: [{ id: pageId }, { node: { id: pageId } }],
            },
            include: { node: true },
          });

          // If pageId was actually a projectId, fetch its root document
          if (!record) {
            const rootNode = await this.prisma.manuscriptNode.findFirst({
              where: { projectId: targetProjectId, isRootDoc: true },
            });
            if (rootNode?.docId) {
              record = await this.prisma.manuscriptDoc.findFirst({
                where: {
                  id: rootNode.docId,
                  projectId: targetProjectId,
                  deleted: false,
                },
                include: { node: true },
              });
            }
          }
        } else {
          // Query by path or filename strictly within the authorized project
          const cleanPath = pageId.startsWith('/') ? pageId.slice(1) : pageId;
          record = await this.prisma.manuscriptDoc.findFirst({
            where: {
              projectId: targetProjectId,
              deleted: false,
              OR: [{ path: `/${cleanPath}` }, { path: cleanPath }],
            },
            include: { node: true },
          });
        }
      } else {
        if (isUuid(pageId)) {
          record = await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            include: { node: true },
          });
        }
      }

      if (!record || record.deleted) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      let doc: {
        _id: string;
        id?: string;
        projectId?: string;
        path: string;
        lines: string[];
        version: number;
        rev: number;
        ranges?: unknown;
        hash?: string | null;
        sizeBytes?: number;
        createdAt?: Date;
        updatedAt?: Date;
      };
      if (record.inStorage) {
        doc = await this.docstoreService.getDoc(record.projectId, record.id);
      } else {
        const rawLines = record.lines;
        const lines = Array.isArray(rawLines)
          ? (rawLines as string[])
          : typeof rawLines === 'string'
            ? rawLines.split('\n')
            : [];
        doc = {
          _id: record.id,
          id: record.id,
          projectId: record.projectId,
          path: record.path,
          lines,
          version: record.version,
          rev: record.rev,
          ranges: record.ranges || {},
          hash: record.hash,
          sizeBytes: record.sizeBytes,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      }

      const lines = doc.lines || [];
      const content = Array.isArray(lines) ? lines.join('\n') : String(lines);

      const title =
        record.node?.name || doc.path?.replace(/^\//, '') || 'document.tex';

      return {
        ...doc,
        page: {
          id: doc._id,
          title,
          content,
          status: 'published',
          projectId: record.projectId,
          mainFile: { id: doc._id, title },
          mainFileId: doc._id,
          rootPageId: doc._id,
          version: doc.version,
          rev: doc.rev,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      };
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

    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';
    const lines = hasNewContent
      ? body.lines ||
        (typeof body.content === 'string' ? body.content.split('\n') : [])
      : await this.getHydratedDocLines(record);

    const result = await this.docstoreService.updateDoc(
      record.projectId,
      pageId,
      {
        lines,
        version: (body.version ?? record.version) + 1,
      },
    );

    const liveSynced = hasNewContent
      ? await this.syncLiveDoc(record.projectId, pageId, lines)
      : false;

    const cleanTitle = body.title
      ? body.title.trim().replace(/^\//, '')
      : undefined;

    if (cleanTitle) {
      const dir = path.posix.dirname(record.path);
      const newPath =
        dir && dir !== '.' && dir !== '/'
          ? `${dir}/${cleanTitle}`
          : `/${cleanTitle}`;
      await Promise.all([
        this.prisma.manuscriptDoc
          .update({
            where: { id: pageId },
            data: { path: newPath },
          })
          .catch(() => null),
        this.prisma.manuscriptNode
          .updateMany({
            where: {
              projectId: record.projectId,
              OR: [{ docId: pageId }, { id: pageId }],
            },
            data: {
              name: cleanTitle,
              path: newPath,
            },
          })
          .catch(() => null),
      ]);
    }

    const existingRanges = (record.ranges as PageDocRanges) || {};
    const updatedRanges = {
      ...existingRanges,
      ...(body.status ? { status: body.status } : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
    };

    if (body.status || body.description !== undefined) {
      await this.prisma.manuscriptDoc
        .update({
          where: { id: pageId },
          data: { ranges: updatedRanges },
        })
        .catch(() => null);
    }

    const updatedLines = result.doc.lines || [];
    const content = Array.isArray(updatedLines)
      ? updatedLines.join('\n')
      : String(updatedLines);

    // Broadcast real-time content notification to collaborating peers
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
          const proj = await this.prisma.project
            .findUnique({
              where: { id: projectId },
              select: { settings: true },
            })
            .catch(() => null);
          if (proj) {
            const settings = (proj.settings as Record<string, unknown>) || {};
            const manuscriptSettings =
              (settings.manuscript as Record<string, unknown>) || {};
            await this.prisma.project
              .update({
                where: { id: projectId },
                data: {
                  settings: {
                    ...settings,
                    manuscript: {
                      ...manuscriptSettings,
                      pdfThumbnail,
                    },
                  },
                },
              })
              .catch(() => null);
          }
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

      let projectId: string | null = null;
      let rootDoc: ManuscriptDoc | null = null;

      let record = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });

      if (!record) {
        const node = await this.prisma.manuscriptNode.findUnique({
          where: { id: pageId },
          include: { doc: true },
        });
        if (node?.doc) {
          record = node.doc;
          projectId = node.projectId;
          rootDoc = node.doc;
        } else if (node) {
          projectId = node.projectId;
        }
      }

      if (record) {
        projectId = record.projectId;
        rootDoc = record;
      } else if (!projectId) {
        const project = await this.prisma.project.findUnique({
          where: { id: pageId },
        });
        if (project) {
          projectId = project.id;
        }
      }

      if (!projectId) {
        return { files: [] };
      }

      const [nodes, allDocs] = await Promise.all([
        this.prisma.manuscriptNode.findMany({
          where: { projectId },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.manuscriptDoc.findMany({
          where: { projectId, deleted: false },
          select: {
            id: true,
            projectId: true,
            path: true,
            lines: true,
            inStorage: true,
            sizeBytes: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      const docMap = new Map(allDocs.map((d) => [d.id, d]));

      const filteredNodes = nodes.filter((node) => {
        if (node.type === 'FOLDER') return false;
        if (node.docId && !docMap.has(node.docId)) return false;
        return true;
      });

      const files = await Promise.all(
        filteredNodes.map(async (node) => {
          const cleanName =
            node.path.replace(/^\//, '') || node.name || 'main.tex';
          const targetDoc = node.docId ? docMap.get(node.docId) : null;
          const docLines = targetDoc
            ? await this.getHydratedDocLines({
                id: targetDoc.id,
                projectId: targetDoc.projectId || projectId!,
                lines: targetDoc.lines,
                inStorage: targetDoc.inStorage,
              })
            : [];
          const content = docLines.join('\n');
          return {
            id: node.docId || node.id,
            nodeId: node.id,
            name: cleanName,
            title: cleanName,
            path: node.path,
            content,
            type: 'file',
            size: node.sizeBytes || (targetDoc?.sizeBytes ?? 0),
            pageId,
            createdAt: node.createdAt.toISOString(),
            updatedAt: node.updatedAt.toISOString(),
          };
        }),
      );

      if (files.length === 0 && rootDoc && !rootDoc.deleted) {
        const cleanName = rootDoc.path.replace(/^\//, '') || 'main.tex';
        const rootLines = await this.getHydratedDocLines(rootDoc);
        const content = rootLines.join('\n');
        files.push({
          id: rootDoc.id,
          nodeId: rootDoc.id,
          name: cleanName,
          title: cleanName,
          path: rootDoc.path,
          content,
          type: 'file',
          size: rootDoc.sizeBytes || 0,
          pageId,
          createdAt: rootDoc.createdAt.toISOString(),
          updatedAt: rootDoc.updatedAt.toISOString(),
        });
      }

      if (files.length === 0) {
        return { files: [] };
      }

      return { files };
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

    const createdDoc = await this.docstoreService.createDoc(projectId, {
      path: `/${cleanName}`,
      text: content,
      version: 1,
    });

    let nodeId = createdDoc._id;
    try {
      const node = await this.prisma.manuscriptNode.create({
        data: {
          projectId,
          name: cleanName,
          path: `/${cleanName}`,
          type: 'DOC',
          docId: createdDoc._id,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
      });
      nodeId = node.id;
    } catch {
      // ignore path conflicts
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

      let pages = await Promise.all(
        rootNodes.map(async (node) => {
          const d = node.doc;
          const ranges = (
            d?.ranges && typeof d.ranges === 'object' ? d.ranges : {}
          ) as PageDocRanges;
          const title =
            (ranges as Record<string, unknown>)?.title &&
            typeof (ranges as Record<string, unknown>).title === 'string'
              ? ((ranges as Record<string, unknown>).title as string)
              : node.name || d?.path?.replace(/^\//, '') || 'Untitled';
          const docLines = d
            ? await this.getHydratedDocLines({
                id: d.id,
                projectId: d.projectId || projectId,
                lines: d.lines,
                inStorage: d.inStorage,
              })
            : [];
          const content = docLines.join('\n');
          const pageLabels = Array.isArray(ranges.labels) ? ranges.labels : [];
          const pageStatus = ranges.status || 'published';
          const pageDescription = ranges.description || '';

          return {
            id: d?.id || node.docId || node.id,
            title,
            description: pageDescription,
            content,
            status: pageStatus,
            projectId,
            author: { name: authorName },
            labels: pageLabels,
            mainFile: { id: d?.id || node.docId || node.id, title },
            mainFileId: d?.id || node.docId || node.id,
            rootPageId: d?.id || node.docId || node.id,
            version: d?.version ?? 1,
            rev: d?.rev ?? 1,
            createdAt:
              d?.createdAt?.toISOString() ?? node.createdAt.toISOString(),
            updatedAt:
              d?.updatedAt?.toISOString() ?? node.updatedAt.toISOString(),
          };
        }),
      );

      if (_search && _search.trim()) {
        const query = _search.trim().toLowerCase();
        pages = pages.filter((p) => p.title.toLowerCase().includes(query));
      }

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
          await Promise.all([
            this.docstoreService.patchDoc(doc.projectId, pageId, {
              deleted: true,
            }),
            this.prisma.manuscriptNode
              .deleteMany({
                where: { projectId: doc.projectId, docId: pageId },
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
      });
      if (doc) {
        projectId = doc.projectId;
      } else {
        const project = await this.prisma.project.findUnique({
          where: { id: pageId },
        });
        if (project) projectId = project.id;
      }
    }

    if (!projectId) {
      return { files: [] };
    }

    const deletedDocs = await this.prisma.manuscriptDoc.findMany({
      where: { projectId, deleted: true },
      orderBy: { updatedAt: 'desc' },
    });

    const deletedFiles = await this.prisma.manuscriptFile.findMany({
      where: { projectId, deleted: true },
      orderBy: { updatedAt: 'desc' },
    });

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
    const doc = targetProjectId
      ? await this.prisma.manuscriptDoc.findFirst({
          where: { id: pageId, projectId: targetProjectId },
        })
      : await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });

    if (doc) {
      await this.docstoreService.patchDoc(doc.projectId, pageId, {
        deleted: false,
      });

      const cleanPath = doc.path.startsWith('/') ? doc.path : `/${doc.path}`;
      const cleanName = doc.path.replace(/^\//, '') || 'restored.tex';
      let existingNode = await this.prisma.manuscriptNode.findFirst({
        where: { projectId: doc.projectId, docId: doc.id },
      });

      if (!existingNode) {
        existingNode = await this.prisma.manuscriptNode.create({
          data: {
            projectId: doc.projectId,
            name: cleanName,
            path: cleanPath,
            type: 'DOC',
            docId: doc.id,
            sizeBytes: doc.sizeBytes || 0,
          },
        });
      }

      this.eventEmitter?.emit('manuscripts.file-tree.change', {
        projectId: doc.projectId,
        change: {
          action: 'create',
          node: existingNode,
        },
      });

      const lines = await this.getHydratedDocLines(doc);
      const content = lines.join('\n');

      return {
        success: true,
        page: {
          id: doc.id,
          title: cleanName,
          content,
          projectId: doc.projectId,
        },
      };
    }

    const file = targetProjectId
      ? await this.prisma.manuscriptFile.findFirst({
          where: { id: pageId, projectId: targetProjectId },
        })
      : await this.prisma.manuscriptFile.findUnique({
          where: { id: pageId },
        });

    if (file) {
      await this.prisma.manuscriptFile.update({
        where: { id: pageId },
        data: { deleted: false },
      });

      let existingNode = await this.prisma.manuscriptNode.findFirst({
        where: { projectId: file.projectId, fileId: file.id },
      });

      if (!existingNode) {
        existingNode = await this.prisma.manuscriptNode.create({
          data: {
            projectId: file.projectId,
            name: file.name,
            path: `/${file.name}`,
            type: 'FILE',
            fileId: file.id,
            sizeBytes: Number(file.sizeBytes || 0),
          },
        });
      }

      this.eventEmitter?.emit('manuscripts.file-tree.change', {
        projectId: file.projectId,
        change: {
          action: 'create',
          node: existingNode,
        },
      });

      return {
        success: true,
        page: {
          id: file.id,
          title: file.name,
          projectId: file.projectId,
        },
      };
    }

    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Document ${pageId} not found`,
    });
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

    const sourceTitle = source.path || 'document.tex';
    const newTitle = sourceTitle.endsWith(' (Copy)')
      ? `${sourceTitle.replace(/ \(Copy\)$/, '')} (Copy 2)`
      : `${sourceTitle} (Copy)`;
    const normalizedNodePath = newTitle.startsWith('/')
      ? newTitle
      : `/${newTitle}`;

    const hydratedSourceLines = await this.getHydratedDocLines(source);

    const newDoc = await this.prisma.manuscriptDoc.create({
      data: {
        projectId: source.projectId,
        path: newTitle,
        lines: hydratedSourceLines,
        rev: 0,
        version: 1,
        ranges: source.ranges ?? {},
        hash: source.hash,
        sizeBytes: source.sizeBytes,
      },
    });

    const sourceNode = await this.prisma.manuscriptNode.findFirst({
      where: { projectId: source.projectId, docId: pageId },
    });

    if (sourceNode) {
      await this.prisma.manuscriptNode.create({
        data: {
          projectId: source.projectId,
          parentId: sourceNode.parentId,
          type: sourceNode.type,
          name: newTitle.replace(/^\//, ''),
          path: normalizedNodePath,
          depth: sourceNode.depth,
          docId: newDoc.id,
          fileId: null,
          isRootDoc: sourceNode.isRootDoc,
          sizeBytes: source.sizeBytes,
          hash: source.hash,
          sortOrder: sourceNode.sortOrder + 1,
        },
      });

      if (this.eventEmitter) {
        this.eventEmitter.emit('manuscripts.file-tree.change', {
          projectId: source.projectId,
          change: {
            action: 'create',
            node: {
              id: newDoc.id,
              path: normalizedNodePath,
              docId: newDoc.id,
            },
          },
        });
      }
    }

    const lines = Array.isArray(newDoc.lines)
      ? (newDoc.lines as string[])
      : hydratedSourceLines;
    const content = lines.join('\n');

    return {
      page: {
        id: newDoc.id,
        title: newDoc.path,
        content,
        status: 'draft',
        projectId: source.projectId,
        version: newDoc.version,
        rev: newDoc.rev,
        createdAt: newDoc.createdAt.toISOString(),
        updatedAt: newDoc.updatedAt.toISOString(),
      },
      mainFile: { id: newDoc.id, title: newDoc.path },
      rootPageId: newDoc.id,
      mainFileId: newDoc.id,
    };
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
      const doc = await this.pageScopeRepo.findDocInProject(projectId, pageId);
      if (!doc) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const targetProjectId = doc.projectId || projectId;
      let labels: { id: string; name: string; color: string }[] = [];
      try {
        const found = await this.prisma.label.findMany({
          where: {
            id: { in: body.labelIds },
            projects: { some: { projectId: targetProjectId } },
          },
        });
        if (found.length > 0) {
          labels = found.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          }));
        } else {
          const foundWork = await this.prisma.workItemLabel.findMany({
            where: { id: { in: body.labelIds }, projectId: targetProjectId },
          });
          labels = foundWork.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          }));
        }
      } catch {
        // Fallback
      }

      await this.pageScopeRepo.updateDocInProject(projectId, pageId, {
        ranges: { labelIds: body.labelIds, labels },
      });

      return { labels };
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
