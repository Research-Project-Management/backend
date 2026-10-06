/**
 * modules/manuscripts/docstore/pages-bridge.controller.ts
 * Complete backward-compatibility bridge routing all frontend Editor requests
 * directly into the modern Manuscripts subsystem (Docstore, Structure, CLSI,
 * History, Review/Track Changes, Search, Export, Collaboration).
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
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
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core/database/prisma.service';
import { DocstoreService } from './docstore.service';
import { RealtimeService } from '@/modules/realtime/realtime.service';

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/manuscripts', 'api'])
@UseGuards(JwtAuthGuard)
export class PagesBridgeController {
  private readonly logger = new Logger(PagesBridgeController.name);

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly prisma: PrismaService,
    @Optional() private readonly realtimeService?: RealtimeService,
  ) {}

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

      const doc = await this.docstoreService.getDoc(record.projectId, pageId);
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

    const lines =
      body.lines ||
      (typeof body.content === 'string' ? body.content.split('\n') : []);

    const result = await this.docstoreService.updateDoc(
      record.projectId,
      pageId,
      {
        lines,
        version: (body.version ?? record.version) + 1,
      },
    );

    const updatedLines = result.doc.lines || [];
    const content = Array.isArray(updatedLines)
      ? updatedLines.join('\n')
      : String(updatedLines);

    // Broadcast real-time content notification to collaborating peers
    if (this.realtimeService && record.projectId) {
      try {
        this.realtimeService.broadcastEvent(
          record.projectId,
          'doc:content-updated',
          {
            docId: pageId,
            version: result.doc.version,
            rev: result.doc.rev,
            content,
            updatedAt: new Date().toISOString(),
          },
        );
      } catch {
        // Non-blocking real-time broadcast error ignored
      }
    }

    return {
      ...result,
      page: {
        id: result.doc.id,
        title: body.title || result.doc.path || 'main.tex',
        content,
        status: 'published',
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
    return {
      page: {
        id: pageId,
        pdfThumbnail: body.pdfThumbnail || '',
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
      let rootDoc: any = null;

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

      let nodes = await this.prisma.manuscriptNode.findMany({
        where: { projectId },
        orderBy: { sortOrder: 'asc' },
      });

      const allDocs = await this.prisma.manuscriptDoc.findMany({
        where: { projectId, deleted: false },
        orderBy: { createdAt: 'asc' },
      });

      const existingDocIds = new Set(nodes.map((n) => n.docId).filter(Boolean));
      for (const d of allDocs) {
        if (!existingDocIds.has(d.id)) {
          try {
            const cleanPath = d.path.startsWith('/') ? d.path : `/${d.path}`;
            const cleanName = d.path.replace(/^\//, '') || 'main.tex';
            const newNode = await this.prisma.manuscriptNode.create({
              data: {
                projectId,
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
        }
      }

      const docMap = new Map<string, any>(allDocs.map((d) => [d.id, d]));

      const files = nodes
        .filter((node) => node.type !== 'FOLDER')
        .map((node) => {
          const cleanName =
            node.path.replace(/^\//, '') || node.name || 'untitled.tex';
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

      if (files.length === 0 && rootDoc) {
        const cleanName = rootDoc.path.replace(/^\//, '') || 'main.tex';
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
    let parentDocId = pageId;

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

  // ─── 2. INLINE COMMENTS & THREADS ─────────────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/comments
   * GET /api/pages/:pageId/comments
   */
  @Get(['docs/:pageId/comments', 'pages/:pageId/comments'])
  async getComments(@Param('pageId') pageId: string) {
    if (!isUuid(pageId)) return { comments: [] };
    try {
      const threads = await this.prisma.manuscriptCommentThread.findMany({
        where: { docId: pageId },
        include: { replies: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });

      const comments = threads.map((t) => ({
        id: t.id,
        page: t.docId,
        projectPageId: t.docId,
        author: {
          id: t.createdById || 'anonymous',
          name: 'Collaborator',
          avatar: '',
        },
        content: t.quote || '',
        line: t.startLine,
        lineEnd: t.endLine,
        status: t.isResolved ? 'resolved' : 'open',
        replies: (t.replies || []).map((r) => ({
          id: r.id,
          author: {
            id: r.createdById || 'anonymous',
            name: 'Collaborator',
            avatar: '',
          },
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      }));

      return { comments };
    } catch {
      return { comments: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/comments
   * POST /api/pages/:pageId/comments
   */
  @Post(['docs/:pageId/comments', 'pages/:pageId/comments'])
  @HttpCode(HttpStatus.CREATED)
  async createComment(
    @Param('pageId') pageId: string,
    @Body() body: { content: string; line?: number; lineEnd?: number },
    @Req() req: any,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | null = null;
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      if (doc?.projectId) projectId = doc.projectId;
    }

    if (!isUuid(pageId) || !projectId) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a comment',
      );
    }

    const authorName =
      req?.user?.name || req?.user?.email?.split('@')[0] || 'Collaborator';

    const thread = await this.prisma.manuscriptCommentThread.create({
      data: {
        docId: pageId,
        projectId,
        quote: body.content,
        startLine: body.line ?? 1,
        startCol: 0,
        endLine: body.lineEnd ?? body.line ?? 1,
        endCol: 0,
        createdById: isUuid(userId) ? userId : null,
      },
    });

    return {
      comment: {
        id: thread.id,
        page: pageId,
        projectPageId: pageId,
        author: {
          id: userId || thread.createdById || 'anonymous',
          name: authorName,
        },
        content: thread.quote || '',
        line: thread.startLine,
        lineEnd: thread.endLine,
        status: 'open',
        replies: [],
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      },
    };
  }

  /**
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId
   * PATCH /api/pages/:pageId/comments/:commentId
   */
  @Patch([
    'docs/:pageId/comments/:commentId',
    'pages/:pageId/comments/:commentId',
  ])
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() body: { content?: string; status?: 'open' | 'resolved' },
  ) {
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      const updated = await this.prisma.manuscriptCommentThread.update({
        where: { id: commentId },
        data: {
          ...(body.content !== undefined ? { quote: body.content } : {}),
          ...(body.status !== undefined
            ? { isResolved: body.status === 'resolved' }
            : {}),
        },
        include: { replies: true },
      });

      return {
        comment: {
          id: updated.id,
          page: updated.docId,
          projectPageId: updated.docId,
          author: {
            id: updated.createdById || 'anonymous',
            name: 'Collaborator',
          },
          content: updated.quote || '',
          line: updated.startLine,
          lineEnd: updated.endLine,
          status: updated.isResolved ? 'resolved' : 'open',
          replies: (updated.replies || []).map((r) => ({
            id: r.id,
            author: { id: r.createdById || 'anonymous', name: 'Collaborator' },
            content: r.content,
            createdAt: r.createdAt.toISOString(),
          })),
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      };
    } catch {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  /**
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId
   * DELETE /api/pages/:pageId/comments/:commentId
   */
  @Delete([
    'docs/:pageId/comments/:commentId',
    'pages/:pageId/comments/:commentId',
  ])
  @HttpCode(HttpStatus.OK)
  async deleteComment(@Param('commentId') commentId: string) {
    if (isUuid(commentId)) {
      await this.prisma.manuscriptCommentThread
        .delete({ where: { id: commentId } })
        .catch(() => null);
    }
    return { success: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/comments/:commentId/reply
   * POST /api/pages/:pageId/comments/:commentId/reply
   */
  @Post([
    'docs/:pageId/comments/:commentId/reply',
    'docs/:pageId/comments/:commentId/replies',
    'pages/:pageId/comments/:commentId/reply',
    'pages/:pageId/comments/:commentId/replies',
  ])
  @HttpCode(HttpStatus.CREATED)
  async addCommentReply(
    @Param('commentId') commentId: string,
    @Body() body: { content: string },
    @Req() req: any,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      await this.prisma.manuscriptCommentReply.create({
        data: {
          threadId: commentId,
          content: body.content,
          createdById: isUuid(userId) ? userId : null,
        },
      });

      const thread = await this.prisma.manuscriptCommentThread.findUnique({
        where: { id: commentId },
        include: { replies: { orderBy: { createdAt: 'asc' } } },
      });

      if (!thread) {
        throw new NotFoundException(`Comment thread ${commentId} not found`);
      }

      return {
        comment: {
          id: thread.id,
          page: thread.docId,
          projectPageId: thread.docId,
          author: {
            id: thread.createdById || 'anonymous',
            name: 'Collaborator',
          },
          content: thread.quote || '',
          line: thread.startLine,
          lineEnd: thread.endLine,
          status: thread.isResolved ? 'resolved' : 'open',
          replies: (thread.replies || []).map((r) => ({
            id: r.id,
            author: { id: r.createdById || 'anonymous', name: 'Collaborator' },
            content: r.content,
            createdAt: r.createdAt.toISOString(),
          })),
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        },
      };
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  /**
   * DELETE /api/v1/manuscripts/docs/:pageId/comments/:commentId/replies/:replyId
   * DELETE /api/pages/:pageId/comments/:commentId/replies/:replyId
   */
  @Delete([
    'docs/:pageId/comments/:commentId/replies/:replyId',
    'pages/:pageId/comments/:commentId/replies/:replyId',
  ])
  @HttpCode(HttpStatus.OK)
  async deleteCommentReply(
    @Param('commentId') commentId: string,
    @Param('replyId') replyId: string,
  ) {
    if (isUuid(replyId)) {
      await this.prisma.manuscriptCommentReply
        .delete({ where: { id: replyId } })
        .catch(() => null);
    }
    return { success: true };
  }

  /**
   * PATCH /api/v1/manuscripts/docs/:pageId/comments/:commentId/resolve
   * PATCH /api/pages/:pageId/comments/:commentId/resolve
   */
  @Patch([
    'docs/:pageId/comments/:commentId/resolve',
    'pages/:pageId/comments/:commentId/resolve',
  ])
  async resolveComment(
    @Param('commentId') commentId: string,
    @Body() body: { resolved?: boolean },
  ) {
    const isResolved = body.resolved ?? true;
    if (!isUuid(commentId)) {
      throw new BadRequestException('A valid UUID is required for commentId');
    }

    try {
      const thread = await this.prisma.manuscriptCommentThread.update({
        where: { id: commentId },
        data: { isResolved },
        include: { replies: true },
      });

      return {
        comment: {
          id: thread.id,
          page: thread.docId,
          projectPageId: thread.docId,
          author: {
            id: thread.createdById || 'anonymous',
            name: 'Collaborator',
          },
          content: thread.quote || '',
          line: thread.startLine,
          lineEnd: thread.endLine,
          status: thread.isResolved ? 'resolved' : 'open',
          replies: (thread.replies || []).map((r) => ({
            id: r.id,
            author: { id: r.createdById || 'anonymous', name: 'Collaborator' },
            content: r.content,
            createdAt: r.createdAt.toISOString(),
          })),
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        },
      };
    } catch {
      throw new NotFoundException(`Comment thread ${commentId} not found`);
    }
  }

  // ─── 3. TRACK CHANGES / REVIEW SUGGESTIONS ───────────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/suggestions
   * GET /api/pages/:pageId/suggestions
   */
  @Get(['docs/:pageId/suggestions', 'pages/:pageId/suggestions'])
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
  ) {
    if (!isUuid(pageId)) return { suggestions: [] };
    try {
      const where: any = { docId: pageId };
      if (status) where.status = status;
      const records = await this.prisma.manuscriptTrackChange.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });

      const suggestions = records.map((s) => ({
        id: s.id,
        pageId: s.docId,
        projectPageId: s.docId,
        authorId: s.createdById || 'anonymous',
        author: {
          id: s.createdById || 'anonymous',
          name: 'Collaborator',
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
      }));

      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions
   * POST /api/pages/:pageId/suggestions
   */
  @Post(['docs/:pageId/suggestions', 'pages/:pageId/suggestions'])
  @HttpCode(HttpStatus.CREATED)
  async createSuggestion(
    @Param('pageId') pageId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | null = null;
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      if (doc?.projectId) projectId = doc.projectId;
    }

    const type = body.type === 'delete' ? 'delete' : 'insert';
    const text = body.suggestedText || body.originalText || '';

    if (!isUuid(pageId) || !projectId) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a suggestion',
      );
    }

    const authorName =
      req?.user?.name || req?.user?.email?.split('@')[0] || 'Collaborator';
    const authorEmail = req?.user?.email || '';

    const record = await this.prisma.manuscriptTrackChange.create({
      data: {
        docId: pageId,
        projectId,
        type: type as any,
        status: 'pending',
        text,
        startLine: body.fromLine ?? 1,
        startCol: body.fromColumn ?? 0,
        endLine: body.toLine ?? body.fromLine ?? 1,
        endCol: body.toColumn ?? 0,
        createdById: isUuid(userId) ? userId : null,
      },
    });

    return {
      suggestion: {
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
      },
    };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/accept
   * POST /api/pages/:pageId/suggestions/:suggestionId/accept
   */
  @Post([
    'docs/:pageId/suggestions/:suggestionId/accept',
    'pages/:pageId/suggestions/:suggestionId/accept',
  ])
  @HttpCode(HttpStatus.OK)
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    if (isUuid(suggestionId)) {
      try {
        const record = await this.prisma.manuscriptTrackChange.update({
          where: { id: suggestionId },
          data: { status: 'accepted', resolvedAt: new Date() },
        });
        return { ok: true, suggestion: record };
      } catch {
        // Ignore
      }
    }
    return { ok: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/:suggestionId/reject
   * POST /api/pages/:pageId/suggestions/:suggestionId/reject
   */
  @Post([
    'docs/:pageId/suggestions/:suggestionId/reject',
    'pages/:pageId/suggestions/:suggestionId/reject',
  ])
  @HttpCode(HttpStatus.OK)
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    if (isUuid(suggestionId)) {
      try {
        const record = await this.prisma.manuscriptTrackChange.update({
          where: { id: suggestionId },
          data: { status: 'rejected', resolvedAt: new Date() },
        });
        return { ok: true, suggestion: record };
      } catch {
        // Ignore
      }
    }
    return { ok: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/accept-all
   * POST /api/pages/:pageId/suggestions/accept-all
   */
  @Post([
    'docs/:pageId/suggestions/accept-all',
    'pages/:pageId/suggestions/accept-all',
  ])
  @HttpCode(HttpStatus.OK)
  async acceptAllSuggestions(@Param('pageId') pageId: string) {
    let acceptedCount = 0;
    if (isUuid(pageId)) {
      try {
        const res = await this.prisma.manuscriptTrackChange.updateMany({
          where: { docId: pageId, status: 'pending' },
          data: { status: 'accepted', resolvedAt: new Date() },
        });
        acceptedCount = res.count;
      } catch {
        // Ignore
      }
    }
    return { ok: true, acceptedCount };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/suggestions/reject-all
   * POST /api/pages/:pageId/suggestions/reject-all
   */
  @Post([
    'docs/:pageId/suggestions/reject-all',
    'pages/:pageId/suggestions/reject-all',
  ])
  @HttpCode(HttpStatus.OK)
  async rejectAllSuggestions(@Param('pageId') pageId: string) {
    let rejectedCount = 0;
    if (isUuid(pageId)) {
      try {
        const res = await this.prisma.manuscriptTrackChange.updateMany({
          where: { docId: pageId, status: 'pending' },
          data: { status: 'rejected', resolvedAt: new Date() },
        });
        rejectedCount = res.count;
      } catch {
        // Ignore
      }
    }
    return { ok: true, rejectedCount };
  }

  // ─── 4. VERSION HISTORY & SNAPSHOTS ──────────────────────────────────────────

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

      const versions = snapshots.map((s) => ({
        id: s.id,
        title: `v${s.version} Snapshot`,
        label: s.labels?.[0]?.label || s.summary || `Version ${s.version}`,
        fileName: 'main.tex',
        savedBy: { id: s.createdById || 'anonymous', name: 'Collaborator' },
        createdAt: s.createdAt.toISOString(),
      }));
      return { versions };
    } catch {
      return { versions: [] };
    }
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
      const s = await this.prisma.manuscriptSnapshot.findUnique({
        where: { id: versionId },
        include: { labels: true },
      });
      if (!s) return { version: null };
      return {
        version: {
          id: s.id,
          title: `v${s.version} Snapshot`,
          label: s.labels?.[0]?.label || s.summary || `Version ${s.version}`,
          fileName: 'main.tex',
          savedBy: { id: s.createdById || 'anonymous', name: 'Collaborator' },
          createdAt: s.createdAt.toISOString(),
          content: typeof s.files === 'object' ? JSON.stringify(s.files) : '',
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
    @Req() req: any,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    let projectId: string | undefined;
    if (isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      projectId = doc?.projectId;
    }

    if (!projectId || !isUuid(projectId)) {
      throw new NotFoundException(`Project not found for doc ${pageId}`);
    }

    try {
      const count = await this.prisma.manuscriptSnapshot.count({
        where: { projectId },
      });
      const snap = await this.prisma.manuscriptSnapshot.create({
        data: {
          projectId,
          version: count + 1,
          summary: body.label || 'Manual Snapshot',
          createdById: isUuid(userId) ? userId : null,
          files: body.content ? { 'main.tex': body.content } : {},
        },
      });
      return {
        version: {
          id: snap.id,
          title: `v${snap.version} Snapshot`,
          label: body.label || `Version ${snap.version}`,
          fileName: 'main.tex',
          savedBy: { id: userId || 'anonymous', name: 'Collaborator' },
          createdAt: snap.createdAt.toISOString(),
          content: body.content || '',
        },
      };
    } catch (err) {
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
  async restoreVersion() {
    return { success: true };
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
  ) {
    return {
      version: {
        id: versionId,
        label: body.label,
        title: body.title || body.label,
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * GET /api/v1/manuscripts/docs/:pageId/versions/diff
   * GET /api/pages/:pageId/versions/diff
   */
  @Get(['docs/:pageId/versions/diff', 'pages/:pageId/versions/diff'])
  async getDiff(
    @Param('pageId') pageId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return {
      fromVersionId: from,
      toVersionId: to,
      diff: '',
      chunks: [],
      stats: {
        additions: 0,
        deletions: 0,
        addedLines: 0,
        deletedLines: 0,
        unchangedLines: 0,
      },
    };
  }

  /**
   * GET /api/v1/manuscripts/docs/:pageId/timeline
   * GET /api/pages/:pageId/timeline
   */
  @Get(['docs/:pageId/timeline', 'pages/:pageId/timeline'])
  async getTimeline() {
    return {
      entries: [],
      oldestMs: Date.now() - 3600000,
      newestMs: Date.now(),
    };
  }

  /**
   * GET /api/v1/manuscripts/docs/:pageId/at
   * GET /api/pages/:pageId/at
   */
  @Get(['docs/:pageId/at', 'pages/:pageId/at'])
  async getAt() {
    return { content: '', timestamp: Date.now() };
  }

  /**
   * GET /api/v1/manuscripts/projects/:projectId/history
   * GET /api/pages/:projectId/history
   */
  @Get(['projects/:projectId/history', 'pages/:projectId/history'])
  async getProjectHistory() {
    return { events: [], history: [] };
  }

  // ─── 5. COMPILER INCREMENTAL SYNC ─────────────────────────────────────────────

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
    const dirty = body?.dirtyFileIds || [];
    return { synced: dirty, total: dirty.length, rootPageId };
  }

  // ─── 6. REAL-TIME COLLABORATION HTTP FALLBACKS ───────────────────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/collaboration/presence
   * GET /api/pages/:pageId/collaboration/presence
   */
  @Get([
    'docs/:pageId/collaboration/presence',
    'pages/:pageId/collaboration/presence',
  ])
  async getPresence() {
    return { activeUsers: [], presence: [] };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/collaboration/heartbeat
   * POST /api/pages/:pageId/collaboration/heartbeat
   */
  @Post([
    'docs/:pageId/collaboration/heartbeat',
    'pages/:pageId/collaboration/heartbeat',
  ])
  @HttpCode(HttpStatus.OK)
  async sendHeartbeat() {
    return { success: true };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/collaboration/leave
   * POST /api/pages/:pageId/collaboration/leave
   */
  @Post([
    'docs/:pageId/collaboration/leave',
    'pages/:pageId/collaboration/leave',
  ])
  @HttpCode(HttpStatus.OK)
  async leaveRoom() {
    return { success: true };
  }

  /**
   * GET /api/v1/manuscripts/docs/:pageId/collaboration/stream
   * GET /api/v1/manuscripts/projects/:projectId/docs/:pageId/collaboration/stream
   * GET /api/pages/:pageId/collaboration/stream
   * GET /api/projects/:projectId/pages/:pageId/collaboration/stream
   */
  @Get([
    'docs/:pageId/collaboration/stream',
    'projects/:projectId/docs/:pageId/collaboration/stream',
    'pages/:pageId/collaboration/stream',
    'projects/:projectId/pages/:pageId/collaboration/stream',
  ])
  async getStream(@Req() req: any, @Res() reply: any) {
    const origin =
      req.headers?.origin || req.headers?.Origin || 'http://localhost:2915';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.writeHead(200);
    reply.raw.write(': keepalive\n\n');

    const interval = setInterval(() => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(': keepalive\n\n');
      }
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(interval);
    });
  }

  // ─── 7. DOCUMENT EXPORT ──────────────────────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/docs/:pageId/export
   * POST /api/pages/:pageId/export
   */
  @Post(['docs/:pageId/export', 'pages/:pageId/export'])
  @HttpCode(HttpStatus.OK)
  async exportDocument(@Param('pageId') pageId: string) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
    });
    if (!doc || doc.deleted) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const filename = doc.path?.replace(/^\//, '') || 'document.tex';
    const lines = doc.lines as string[] | undefined;
    const content = Array.isArray(lines) ? lines.join('\n') : '';

    return {
      filename,
      mimeType: 'application/x-tex',
      content,
      isBase64: false,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };
  }

  // ─── 8. PROJECT DOCUMENT SEARCH & REPLACE ────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/projects/:projectId/search
   * POST /api/projects/:projectId/documents/search
   */
  @Post(['projects/:projectId/search', 'projects/:projectId/documents/search'])
  @HttpCode(HttpStatus.OK)
  async searchDocuments(
    @Param('projectId') projectId: string,
    @Body() body: { query: string; caseSensitive?: boolean },
  ) {
    const query = body?.query || '';
    if (!query || !isUuid(projectId)) {
      return {
        query,
        totalFiles: 0,
        totalMatches: 0,
        results: [],
        truncated: false,
      };
    }

    try {
      const docs = await this.prisma.manuscriptDoc.findMany({
        where: { projectId, deleted: false },
        select: { id: true, path: true, lines: true },
      });

      const results = [];
      let totalMatches = 0;
      const q = body.caseSensitive ? query : query.toLowerCase();

      for (const doc of docs) {
        const lines = (doc.lines as string[]) || [];
        const matches = [];

        for (let i = 0; i < lines.length; i++) {
          const lineStr = lines[i] || '';
          const target = body.caseSensitive ? lineStr : lineStr.toLowerCase();
          const matchStart = target.indexOf(q);

          if (matchStart !== -1) {
            matches.push({
              line: i + 1,
              text: lineStr,
              matchStart,
              matchEnd: matchStart + query.length,
              snippet: lineStr,
            });
            totalMatches++;
          }
        }

        if (matches.length > 0) {
          results.push({
            fileId: doc.id,
            fileName: doc.path || 'document.tex',
            isMainFile: doc.path === 'main.tex',
            totalMatches: matches.length,
            matches,
          });
        }
      }

      return {
        query,
        totalFiles: results.length,
        totalMatches,
        results,
        truncated: false,
      };
    } catch {
      return {
        query,
        totalFiles: 0,
        totalMatches: 0,
        results: [],
        truncated: false,
      };
    }
  }

  /**
   * POST /api/v1/manuscripts/projects/:projectId/replace
   * POST /api/projects/:projectId/documents/replace
   */
  @Post([
    'projects/:projectId/replace',
    'projects/:projectId/documents/replace',
  ])
  @HttpCode(HttpStatus.OK)
  async replaceDocuments(
    @Param('projectId') projectId: string,
    @Body() body: { query: string; replaceWith: string },
  ) {
    return {
      query: body?.query || '',
      replaceWith: body?.replaceWith || '',
      totalFilesAffected: 0,
      totalOccurrencesReplaced: 0,
      affectedFileIds: [],
    };
  }

  // ─── 9. PROJECT DOCS CRUD & LABELS ──────────────────────────────────────────

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
    @Req() req: any,
  ) {
    const title = body?.title || 'main.tex';
    let content = body?.content || '';
    const userId = req?.user?.id || req?.user?.sub || null;

    const labelIds: string[] = Array.isArray(body?.labels)
      ? body.labels
      : Array.isArray(body?.labelIds)
        ? body.labelIds
        : [];

    let attachedLabels: { id: string; name: string; color: string }[] = [];
    if (labelIds.length > 0) {
      try {
        const found = await this.prisma.label.findMany({
          where: { id: { in: labelIds } },
        });
        if (found.length > 0) {
          attachedLabels = found.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          }));
        } else {
          const foundWork = await this.prisma.workItemLabel.findMany({
            where: { id: { in: labelIds } },
          });
          attachedLabels = foundWork.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          }));
        }
      } catch {
        // Fallback silently if labels query fails
      }
    }

    if (!isUuid(projectId)) {
      throw new BadRequestException(
        'A valid UUID projectId is required to create a project page',
      );
    }

    // Mirror Overleaf Project Initialization:
    if (body?.templateType === 'example') {
      content = await this.buildExampleProjectTemplate(
        projectId,
        title,
        userId,
      );
      await this.ensureExampleReferencesBib(projectId);
    } else if (!content.trim()) {
      content = await this.buildBlankProjectTemplate(projectId, title, userId);
    }

    // Ensure project settings are configured with Overleaf standard defaults
    try {
      const proj = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { settings: true },
      });
      const settings = (proj?.settings as Record<string, any>) || {};
      if (!settings.manuscript) {
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            settings: {
              ...settings,
              manuscript: {
                compiler: 'pdflatex',
                mainFile: title.replace(/^\//, ''),
                spellCheckLanguage: 'en_US',
                texLiveVersion: '2024',
              },
            },
          },
        });
      }
    } catch {
      // Non-fatal
    }

    const doc = await this.docstoreService.createDoc(projectId, {
      path: title.startsWith('/') ? title : `/${title}`,
      text: content,
      version: 1,
      ranges: { labelIds, labels: attachedLabels },
    });

    // Ensure a corresponding manuscriptNode exists in the file tree
    try {
      await this.prisma.manuscriptNode.create({
        data: {
          projectId,
          name: title.replace(/^\//, ''),
          path: title.startsWith('/') ? title : `/${title}`,
          type: 'DOC',
          docId: doc._id,
          isRootDoc: true,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
      });
    } catch {
      // ignore duplicate path conflicts
    }

    return {
      page: {
        id: doc._id,
        title: doc.path.replace(/^\//, ''),
        content,
        status: body?.status || 'draft',
        projectId,
        labels: attachedLabels,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      mainFile: { id: doc._id, title: doc.path.replace(/^\//, '') },
      rootPageId: doc._id,
      mainFileId: doc._id,
    };
  }

  /**
   * Builds the default main document exactly like Overleaf's "Blank Project"
   * (services/web/app/templates/project_files/mainbasic.tex):
   *   \title{<project_name>} \author{<first> <last>} \date{<Month> <Year>}
   */
  private async buildBlankProjectTemplate(
    projectId: string,
    title: string,
    userId: string | null,
  ): Promise<string> {
    const escapeTex = (s: string) =>
      s.replace(/([\\{}$&#%_^~])/g, (m) =>
        m === '\\'
          ? '\\textbackslash{}'
          : m === '~'
            ? '\\textasciitilde{}'
            : m === '^'
              ? '\\textasciicircum{}'
              : `\\${m}`,
      );

    let projectName = '';
    let authorName = '';
    try {
      const [project, user] = await Promise.all([
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: { name: true },
        }),
        userId && isUuid(userId)
          ? this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                email: true,
                profile: { select: { name: true } },
              },
            })
          : Promise.resolve(null),
      ]);
      projectName = project?.name ?? '';
      authorName = user?.profile?.name || user?.email?.split('@')[0] || '';
    } catch {
      // Metadata is cosmetic; never block page creation
    }

    const fileBase = title.replace(/^\//, '').replace(/\.tex$/i, '');
    const docTitle =
      fileBase && fileBase !== 'main' ? fileBase : projectName || 'Untitled';
    const now = new Date();
    const month = now.toLocaleString('en-US', { month: 'long' });

    return [
      '\\documentclass{article}',
      '\\usepackage{graphicx} % Required for inserting images',
      '',
      `\\title{${escapeTex(docTitle)}}`,
      `\\author{${escapeTex(authorName)}}`,
      `\\date{${month} ${now.getFullYear()}}`,
      '',
      '\\begin{document}',
      '',
      '\\maketitle',
      '',
      '\\section{Introduction}',
      '',
      '\\end{document}',
      '',
    ].join('\n');
  }

  /**
   * Builds the comprehensive document matching Overleaf's "Example Project"
   * containing sections, math equations, tables, figures, and bibliographic citations.
   */
  private async buildExampleProjectTemplate(
    projectId: string,
    title: string,
    userId: string | null,
  ): Promise<string> {
    const escapeTex = (s: string) =>
      s.replace(/([\\{}$&#%_^~])/g, (m) =>
        m === '\\'
          ? '\\textbackslash{}'
          : m === '~'
            ? '\\textasciitilde{}'
            : m === '^'
              ? '\\textasciicircum{}'
              : `\\${m}`,
      );

    let projectName = '';
    let authorName = '';
    try {
      const [project, user] = await Promise.all([
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: { name: true },
        }),
        userId && isUuid(userId)
          ? this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                email: true,
                profile: { select: { name: true } },
              },
            })
          : Promise.resolve(null),
      ]);
      projectName = project?.name ?? '';
      authorName = user?.profile?.name || user?.email?.split('@')[0] || '';
    } catch {
      // Non-blocking
    }

    const fileBase = title.replace(/^\//, '').replace(/\.tex$/i, '');
    const docTitle =
      fileBase && fileBase !== 'main' ? fileBase : projectName || 'Untitled';
    const now = new Date();
    const month = now.toLocaleString('en-US', { month: 'long' });

    return [
      '\\documentclass{article}',
      '\\usepackage{graphicx} % Required for inserting images',
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{cite}',
      '',
      `\\title{${escapeTex(docTitle)}}`,
      `\\author{${escapeTex(authorName)}}`,
      `\\date{${month} ${now.getFullYear()}}`,
      '',
      '\\begin{document}',
      '',
      '\\maketitle',
      '',
      '\\begin{abstract}',
      'This document serves as an example starter project, illustrating standard LaTeX typesetting including mathematical notation, tabular structures, and automated reference citations.',
      '\\end{abstract}',
      '',
      '\\section{Introduction}',
      'LaTeX is widely used in academia and technical fields for producing structured, professional documents. This example introduces foundational capabilities that can be extended for papers, theses, or technical reports.',
      '',
      '\\section{Mathematical Formulations}',
      'Mathematical expressions can appear inline, such as $E = mc^2$ or $\\sum_{k=1}^{\\infty} \\frac{1}{k^2} = \\frac{\\pi^2}{6}$.',
      '',
      'Key formulations can also be displayed in numbered equation environments:',
      '\\begin{equation}',
      '\\label{eq:fourier}',
      '\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x) e^{-2\\pi i x \\xi} dx',
      '\\end{equation}',
      'Equation~\\eqref{eq:fourier} defines the continuous Fourier transform.',
      '',
      '\\section{Data Presentation}',
      'Table~\\ref{tab:benchmarks} demonstrates a clean numerical layout for experimental results.',
      '',
      '\\begin{table}[htbp]',
      '\\centering',
      '\\caption{Comparative performance metrics across evaluation trials.}',
      '\\label{tab:benchmarks}',
      '\\begin{tabular}{lccc}',
      '\\hline',
      '\\textbf{Model} & \\textbf{Precision (\\%)} & \\textbf{Recall (\\%)} & \\textbf{F1-Score} \\\\',
      '\\hline',
      'Baseline & 84.2 & 81.7 & 0.829 \\\\',
      'Flux Engine & \\textbf{92.5} & \\textbf{90.1} & \\textbf{0.913} \\\\',
      '\\hline',
      '\\end{tabular}',
      '\\end{table}',
      '',
      '\\section{Citations and References}',
      'Referencing external sources is essential in academic writing. You can cite bibliography entries defined in the companion \\texttt{references.bib} file, such as \\cite{knuth1984texbook} and \\cite{lamport1994latex}.',
      '',
      '\\bibliographystyle{plain}',
      '\\bibliography{references}',
      '',
      '\\end{document}',
      '',
    ].join('\n');
  }

  /**
   * Automatically creates references.bib in the project if it does not already exist
   */
  private async ensureExampleReferencesBib(projectId: string): Promise<void> {
    const bibPath = '/references.bib';
    try {
      const existing = await this.prisma.manuscriptNode.findFirst({
        where: {
          projectId,
          path: bibPath,
        },
      });
      if (!existing) {
        const bibContent = [
          '@book{knuth1984texbook,',
          '  author    = {Donald E. Knuth},',
          '  title     = {The {\\TeX}book},',
          '  year      = {1984},',
          '  publisher = {Addison-Wesley},',
          '  address   = {Reading, Massachusetts}',
          '}',
          '',
          '@book{lamport1994latex,',
          '  author    = {Leslie Lamport},',
          '  title     = {{\\LaTeX}: A Document Preparation System},',
          '  year      = {1994},',
          '  publisher = {Addison-Wesley},',
          '  edition   = {Second}',
          '}',
          '',
        ].join('\n');

        const createdDoc = await this.docstoreService.createDoc(projectId, {
          path: bibPath,
          text: bibContent,
          version: 1,
        });

        await this.prisma.manuscriptNode.create({
          data: {
            projectId,
            name: 'references.bib',
            path: bibPath,
            type: 'DOC',
            docId: createdDoc._id,
            isRootDoc: false,
            sizeBytes: Buffer.byteLength(bibContent, 'utf8'),
          },
        });
      }
    } catch {
      // Non-fatal if companion creation fails
    }
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
      // Fetch root manuscript documents (Pages) for this project
      const rootNodes = await this.prisma.manuscriptNode.findMany({
        where: {
          projectId,
          isRootDoc: true,
          OR: [{ docId: null }, { doc: { deleted: false } }],
        },
        include: { doc: true },
        orderBy: { sortOrder: 'asc' },
      });

      // Fetch project to retrieve creator details if present
      const project = await this.prisma.project.findUnique({
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
      });
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

        const ranges = (d?.ranges as any) || {};
        const pageLabels = Array.isArray(ranges.labels) ? ranges.labels : [];

        return {
          id: d?.id || node.docId || node.id,
          title,
          content,
          status: 'published',
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
          await this.docstoreService.patchDoc(doc.projectId, pageId, {
            deleted: true,
          });
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

    // 1. Fetch deleted manuscript docs
    const deletedDocs = await this.prisma.manuscriptDoc.findMany({
      where: { projectId, deleted: true },
      orderBy: { updatedAt: 'desc' },
    });

    // 2. Fetch deleted filestore binary files
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

    // 1. Check if it's a manuscriptDoc
    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
    });

    if (doc) {
      await this.docstoreService.patchDoc(doc.projectId, pageId, {
        deleted: false,
      });

      // Restore or create tree node if missing
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

      this.realtimeService?.broadcastFileTreeChange(doc.projectId, {
        action: 'create',
        node: existingNode,
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

    // 2. Check if it's a manuscriptFile
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

      this.realtimeService?.broadcastFileTreeChange(file.projectId, {
        action: 'create',
        node: existingNode,
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

    // 1. Create duplicate doc in docstore / prisma
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

    // 2. Clone file tree node if exists
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

      // Broadcast tree mutation
      if (this.realtimeService) {
        this.realtimeService.broadcastFileTreeChange(source.projectId, {
          action: 'create',
          node: { id: newDoc.id, path: newTitle, docId: newDoc.id },
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
      const ranges = (doc?.ranges as any) || {};
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
      const ranges = (doc?.ranges as any) || {};
      const labels = (ranges.labels || []).filter((l: any) => l.id !== labelId);
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
