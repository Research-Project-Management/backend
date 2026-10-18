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
import { ProjectRoleGuard, RequireRole, Role } from '@/modules/project/access';
import { ManuscriptDoc } from '@prisma/client';
import { PrismaService, AuthenticatedRequest } from '@/core';
import * as path from 'path';
import { ModuleRef } from '@nestjs/core';
import { DocstoreService } from '../docstore.service';
import { ManuscriptProjectBootstrapService } from '../services/manuscript-project-bootstrap.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '../domain';

export interface PageDocRanges {
  labels?: Array<{ id: string; name?: string; color?: string }>;
  labelIds?: string[];
  status?: string;
  description?: string;
  pdfThumbnail?: string;
  [key: string]: unknown;
}

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/manuscripts', 'v1/manuscripts', 'manuscripts', 'api'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
@RequireRole(Role.REVIEWER)
export class PagesDocController {
  private readonly logger = new Logger(PagesDocController.name);
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly prisma: PrismaService,
    private readonly projectBootstrapService: ManuscriptProjectBootstrapService,
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

  // ─── 1. CORE DOCUMENT CONTENT & METADATA ──────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId
   * GET /api/pages/:pageId
   */
  @Get(['docs/:pageId', 'pages/:pageId'])
  @ApiOperation({ summary: 'Get document by pageId from database' })
  async getPageById(@Param('pageId') pageId: string) {
    try {
      let record = null;

      if (isUuid(pageId)) {
        record = await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          include: { node: true },
        });

        // If pageId was actually a projectId, fetch its root document
        if (!record || record.deleted) {
          const rootNode = await this.prisma.manuscriptNode.findFirst({
            where: { projectId: pageId, isRootDoc: true },
          });
          if (rootNode?.docId) {
            record = await this.prisma.manuscriptDoc.findUnique({
              where: { id: rootNode.docId },
              include: { node: true },
            });
          }
        }
      } else {
        // Query by path or filename
        record = await this.prisma.manuscriptDoc.findFirst({
          where: {
            OR: [{ path: `/${pageId}` }, { path: pageId }],
            deleted: false,
          },
          include: { node: true },
        });
      }

      if (!record || record.deleted) {
        throw new NotFoundException(`Document ${pageId} not found`);
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
   * PUT /api/pages/:pageId
   */
  @Put(['docs/:pageId', 'pages/:pageId'])
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
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const record = await this.prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
    });

    if (!record || record.deleted) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';
    const lines = hasNewContent
      ? body.lines ||
        (typeof body.content === 'string' ? body.content.split('\n') : [])
      : Array.isArray(record.lines)
        ? (record.lines as string[])
        : typeof record.lines === 'string'
          ? record.lines.split('\n')
          : [];

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
   * PUT /api/pages/:pageId/thumbnail
   */
  @Put(['docs/:pageId/thumbnail', 'pages/:pageId/thumbnail'])
  @HttpCode(HttpStatus.OK)
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() body: { pdfThumbnail?: string },
  ) {
    const pdfThumbnail = body?.pdfThumbnail || '';

    if (isUuid(pageId)) {
      try {
        const record = await this.prisma.manuscriptDoc.findUnique({
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
   * GET /api/pages/:pageId/files
   */
  @Get(['docs/:pageId/files', 'pages/:pageId/files'])
  async getPageFiles(@Param('pageId') pageId: string) {
    try {
      if (!isUuid(pageId)) {
        return { files: [] };
      }

      let projectId: string | null = null;
      let rootDoc: ManuscriptDoc | null = null;

      const record = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });

      if (record) {
        projectId = record.projectId;
        rootDoc = record;
      } else {
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
            path: true,
            lines: true,
            sizeBytes: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      const existingDocIds = new Set(nodes.map((n) => n.docId).filter(Boolean));
      const missingDocs = allDocs.filter((d) => !existingDocIds.has(d.id));
      if (missingDocs.length > 0) {
        await Promise.all(
          missingDocs.map(async (d) => {
            try {
              const cleanPath = d.path.startsWith('/') ? d.path : `/${d.path}`;
              const cleanName = d.path.replace(/^\//, '') || 'main.tex';
              const newNode = await this.prisma.manuscriptNode.create({
                data: {
                  projectId: projectId,
                  name: cleanName,
                  path: cleanPath,
                  type: 'DOC',
                  docId: d.id,
                  isRootDoc: d.id === rootDoc?.id,
                  sizeBytes: d.sizeBytes || 0,
                },
              });
              nodes.push(newNode);
              existingDocIds.add(d.id);
            } catch {
              // ignore duplicate path
            }
          }),
        );
      }

      const docMap = new Map(allDocs.map((d) => [d.id, d]));

      const files = nodes
        .filter((node) => {
          if (node.type === 'FOLDER') return false;
          if (node.docId && !docMap.has(node.docId)) return false;
          return true;
        })
        .map((node) => {
          let cleanName =
            node.path.replace(/^\//, '') || node.name || 'main.tex';
          if (node.isRootDoc && cleanName === 'flux') {
            cleanName = 'main.tex';
          }
          const targetDoc = node.docId ? docMap.get(node.docId) : null;
          const docLines = targetDoc?.lines || [];
          const content = Array.isArray(docLines)
            ? docLines.join('\n')
            : String(docLines || '');
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
        });

      if (files.length === 0 && rootDoc && !rootDoc.deleted) {
        let cleanName = rootDoc.path.replace(/^\//, '') || 'main.tex';
        if (cleanName === 'flux') {
          cleanName = 'main.tex';
        }
        const rootLines = rootDoc.lines || [];
        const content = Array.isArray(rootLines)
          ? rootLines.join('\n')
          : String(rootLines || '');
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
   * POST /api/pages/:pageId/files
   */
  @Post(['docs/:pageId/files', 'pages/:pageId/files'])
  @HttpCode(HttpStatus.CREATED)
  async createPageFile(
    @Param('pageId') pageId: string,
    @Body() body: { title?: string; name?: string; content?: string },
  ) {
    const fileName = body?.title || body?.name || 'untitled.tex';
    const cleanName = fileName.trim().replace(/^\//, '');
    const content = body?.content || '';

    let projectId: string | null = null;
    const parentDocId = pageId;

    if (isUuid(pageId)) {
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
   * POST /api/projects/:projectId/pages
   */
  @Post(['projects/:projectId/docs', 'projects/:projectId/pages'])
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
   * GET /api/projects/:projectId/pages
   */
  @Get(['projects/:projectId/docs', 'projects/:projectId/pages'])
  async getProjectPages(
    @Param('projectId') projectId: string,
    @Query('status') _status?: string,
    @Query('search') _search?: string,
    @Query('forceEmpty') forceEmpty?: string,
    @Query('forceError') forceError?: string,
  ) {
    if (forceError === 'true') {
      throw new InternalServerErrorException(
        'Simulated internal server error while fetching project pages',
      );
    }
    if (forceEmpty === 'true') {
      return { pages: [], total: 0, isEmpty: true };
    }
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

      let pages = rootNodes.map((node) => {
        const d = node.doc;
        const title = node.name || d?.path?.replace(/^\//, '') || 'Untitled';
        const content =
          d && Array.isArray(d.lines)
            ? (d.lines as string[]).join('\n')
            : typeof d?.lines === 'string'
              ? d.lines
              : '';

        const ranges = (
          d?.ranges && typeof d.ranges === 'object' ? d.ranges : {}
        ) as PageDocRanges;
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
      });

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
   * DELETE /api/pages/:pageId
   */
  @Delete(['docs/:pageId', 'pages/:pageId'])
  @HttpCode(HttpStatus.OK)
  async deletePage(@Param('pageId') pageId: string) {
    if (isUuid(pageId)) {
      try {
        const doc = await this.prisma.manuscriptDoc.findUnique({
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
   * GET /api/pages/:pageId/deleted-files
   */
  @Get(['docs/:pageId/deleted-files', 'pages/:pageId/deleted-files'])
  @ApiOperation({ summary: 'Get list of deleted/trashed files in project' })
  async getDeletedFiles(@Param('pageId') pageId: string) {
    let projectId: string | null = null;
    if (isUuid(pageId)) {
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
   * POST /api/pages/:pageId/restore
   */
  @Post(['docs/:pageId/restore', 'pages/:pageId/restore'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a soft-deleted document or file' })
  async restorePage(@Param('pageId') pageId: string) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const doc = await this.prisma.manuscriptDoc.findUnique({
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

      const lines = doc.lines || [];
      const content = Array.isArray(lines) ? lines.join('\n') : String(lines);

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

    const file = await this.prisma.manuscriptFile.findUnique({
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

    throw new NotFoundException(`Item ${pageId} not found to restore`);
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/duplicate
   * POST /api/v1/manuscripts/docs/:pageId/clone
   * POST /api/v1/manuscripts/pages/:pageId/duplicate
   * POST /api/v1/manuscripts/pages/:pageId/clone
   * POST /api/docs/:pageId/duplicate
   * POST /api/docs/:pageId/clone
   * POST /api/pages/:pageId/duplicate
   * POST /api/pages/:pageId/clone
   */
  @Post([
    'docs/:pageId/duplicate',
    'docs/:pageId/clone',
    'pages/:pageId/duplicate',
    'pages/:pageId/clone',
  ])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Duplicate/clone a page by pageId with its content and tree node',
  })
  async duplicatePage(@Param('pageId') pageId: string) {
    if (!isUuid(pageId)) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const source = await this.prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
    });

    if (!source) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const sourceTitle = source.path || 'document.tex';
    const newTitle = sourceTitle.endsWith(' (Copy)')
      ? `${sourceTitle.replace(/ \(Copy\)$/, '')} (Copy 2)`
      : `${sourceTitle} (Copy)`;

    const newDoc = await this.prisma.manuscriptDoc.create({
      data: {
        projectId: source.projectId,
        path: newTitle,
        lines: source.lines ?? [],
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
          name: newTitle,
          path: newTitle,
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
            node: { id: newDoc.id, path: newTitle, docId: newDoc.id },
          },
        });
      }
    }

    const lines = Array.isArray(newDoc.lines) ? newDoc.lines : [];
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
  @Get([
    'projects/:projectId/docs/:pageId/labels',
    'projects/:projectId/pages/:pageId/labels',
  ])
  async getPageLabels(@Param('pageId') pageId: string) {
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });
      const ranges = (
        doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
      ) as PageDocRanges;
      const labels = ranges.labels || [];
      return { labels };
    }
    return { labels: [] };
  }

  @Post([
    'projects/:projectId/docs/:pageId/labels',
    'projects/:projectId/pages/:pageId/labels',
  ])
  async assignPageLabels(
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    if (isUuid(pageId) && Array.isArray(body?.labelIds)) {
      let labels: { id: string; name: string; color: string }[] = [];
      try {
        const found = await this.prisma.label.findMany({
          where: { id: { in: body.labelIds } },
        });
        if (found.length > 0) {
          labels = found.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          }));
        } else {
          const foundWork = await this.prisma.workItemLabel.findMany({
            where: { id: { in: body.labelIds } },
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

      await this.prisma.manuscriptDoc
        .update({
          where: { id: pageId },
          data: { ranges: { labelIds: body.labelIds, labels } },
        })
        .catch(() => null);

      return { labels };
    }
    return { labels: [] };
  }

  @Put([
    'projects/:projectId/docs/:pageId/labels',
    'projects/:projectId/pages/:pageId/labels',
  ])
  async replacePageLabels(
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    return this.assignPageLabels(pageId, body);
  }

  @Delete([
    'projects/:projectId/docs/:pageId/labels/:labelId',
    'projects/:projectId/pages/:pageId/labels/:labelId',
  ])
  async removePageLabel(
    @Param('pageId') pageId: string,
    @Param('labelId') labelId: string,
  ) {
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });
      const ranges = (
        doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
      ) as PageDocRanges;
      const labels = (ranges.labels || []).filter((l) => l.id !== labelId);
      const labelIds = (ranges.labelIds || []).filter(
        (id: string) => id !== labelId,
      );
      await this.prisma.manuscriptDoc
        .update({
          where: { id: pageId },
          data: { ranges: { labelIds, labels } },
        })
        .catch(() => null);
      return { labels };
    }
    return { labels: [] };
  }
}

export { PagesDocController as PagesBridgeController };
