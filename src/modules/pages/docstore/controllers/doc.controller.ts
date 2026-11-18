/**
 * modules/manuscripts/docstore/controllers/doc.controller.ts
 * Thin Domain Controller handling Document CRUD, Files, Trash/Restore,
 * Duplicate/Clone, Project Pages, and Labels.
 * Delegates aggregate lifecycle and business logic to ManuscriptPageService.
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
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import { DocstoreService } from '../docstore.service';
import {
  PageService,
  UpdatePageContentParams,
  CreatePageFileParams,
  ImportFromProjectParams,
  CreateProjectPageParams,
  PageDocRanges,
} from '@/modules/pages/core/services/page.service';

export type { PageDocRanges };

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class DocController {
  constructor(
    private readonly pageService: PageService,
    private readonly docstoreService: DocstoreService,
  ) {}

  // ─── 1. CORE DOCUMENT CONTENT & METADATA ──────────────────────────────────────

  /**
   * GET /api/v1/manuscripts/pages/:pageId
   * GET /api/v1/manuscripts/docs/:pageId
   */
  @Get(['pages/:pageId', 'docs/:pageId'])
  @ApiOperation({ summary: 'Get document by pageId from database' })
  async getPageById(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getPageById(pageId, authorizedProjectId);
  }

  /**
   * PUT /api/v1/manuscripts/pages/:pageId
   * PUT /api/v1/manuscripts/docs/:pageId
   * PUT /api/v1/manuscripts/projects/:projectId/docs/:pageId
   * PUT /api/v1/manuscripts/projects/:projectId/docs/doc/:pageId
   */
  @Put([
    'pages/:pageId',
    'docs/:pageId',
    'spaces/:spaceId/docs/:pageId',
    'spaces/:spaceId/docs/doc/:pageId',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Update document content by pageId' })
  async updatePageContent(
    @Param('pageId') pageId: string,
    @Body() body: UpdatePageContentParams,
    @Param('spaceId') routeSpaceId?: string,
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    return this.pageService.updatePageContent(
      pageId,
      body,
      authorizedSpaceId || routeSpaceId,
    );
  }

  /**
   * POST /api/v1/pages/spaces/:spaceId/docs/:pageId
   * POST /api/v1/pages/spaces/:spaceId/docs/doc/:pageId
   * POST /api/v1/pages/spaces/:spaceId/updater/doc/:pageId/update
   */
  @Post([
    'spaces/:spaceId/docs/:pageId',
    'spaces/:spaceId/docs/doc/:pageId',
    'spaces/:spaceId/updater/doc/:pageId/update',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update or queue document lines with OCC enforcement',
  })
  async updateOrQueueDocLines(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body()
    body: UpdatePageContentParams & {
      docLines?: string[];
      rev?: number;
      clientRev?: number;
    },
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    const normalizedBody: UpdatePageContentParams = {
      ...body,
      lines: body.lines ?? body.docLines,
      expectedRev: body.expectedRev ?? body.rev ?? body.clientRev,
    };
    return this.pageService.updatePageContent(
      pageId,
      normalizedBody,
      authorizedSpaceId || spaceId,
    );
  }

  /**
   * PATCH /api/v1/pages/spaces/:spaceId/docs/:pageId
   * PATCH /api/v1/pages/spaces/:spaceId/docs/doc/:pageId
   */
  @Patch(['spaces/:spaceId/docs/:pageId', 'spaces/:spaceId/docs/doc/:pageId'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Patch document path or soft-delete metadata' })
  async patchProjectDoc(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body()
    body: {
      path?: string;
      name?: string;
      deleted?: boolean;
      deletedAt?: string;
    },
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    const resolvedSpaceId =
      (typeof authorizedSpaceId === 'string'
        ? authorizedSpaceId
        : authorizedSpaceId?.id) || spaceId;
    return this.docstoreService.patchDoc(resolvedSpaceId, pageId, body);
  }

  /**
   * PUT /api/v1/manuscripts/pages/:pageId/thumbnail
   * PUT /api/v1/manuscripts/docs/:pageId/thumbnail
   */
  @Put(['pages/:pageId/thumbnail', 'docs/:pageId/thumbnail'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() body: { pdfThumbnail?: string },
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.updateThumbnail(
      pageId,
      body?.pdfThumbnail || '',
      authorizedProjectId,
    );
  }

  /**
   * GET /api/v1/manuscripts/pages/:pageId/files
   * GET /api/v1/manuscripts/docs/:pageId/files
   */
  @Get('docs/:pageId/files')
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('includeContent') includeContent?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const shouldInclude = includeContent === 'true' || includeContent === '1';
    return this.pageService.getPageFiles(pageId, authorizedProjectId, {
      includeContent: shouldInclude,
    });
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/files
   * POST /api/v1/manuscripts/docs/:pageId/files
   */
  @Post('docs/:pageId/files')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createPageFile(
    @Param('pageId') pageId: string,
    @Body() body: CreatePageFileParams,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.createPageFile(pageId, body, authorizedProjectId);
  }

  /**
   * POST /api/v1/manuscripts/projects/:projectId/files/import-from-project
   * POST /api/v1/manuscripts/pages/:projectId/files/import-from-project
   * POST /api/v1/manuscripts/docs/:projectId/files/import-from-project
   */
  @Post([
    'spaces/:spaceId/files/import-from-project',
    'pages/:spaceId/files/import-from-project',
    'docs/:spaceId/files/import-from-project',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Import/copy a document or binary file from another project on the server',
  })
  async importFileFromProject(
    @Param('spaceId') spaceId: string,
    @Body() body: ImportFromProjectParams,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpaceId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.pageService.importFileFromProject(
      spaceId,
      body,
      authorizedSpaceId,
      userId,
    );
  }

  // ─── 2. PROJECT PAGES CRUD & LABELS ──────────────────────────────────────────

  /**
   * POST /api/v1/pages/spaces/:spaceId/pages
   * POST /api/v1/pages/spaces/:spaceId/docs
   */
  @Post(['spaces/:spaceId/pages', 'spaces/:spaceId/docs'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createProjectPage(
    @Param('spaceId') spaceId: string,
    @Body() body: CreateProjectPageParams,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.pageService.createProjectPage(spaceId, body, userId);
  }

  /**
   * GET /api/v1/pages/spaces/:spaceId/pages
   * GET /api/v1/pages/spaces/:spaceId/docs
   */
  @Get(['spaces/:spaceId/pages', 'spaces/:spaceId/docs'])
  async getProjectPages(
    @Param('spaceId') spaceId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.pageService.getProjectPages(spaceId, { status, search });
  }

  /**
   * DELETE /api/v1/manuscripts/pages/:pageId
   * DELETE /api/v1/manuscripts/docs/:pageId
   */
  @Delete(['pages/:pageId', 'docs/:pageId'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async deletePage(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.deletePage(pageId, authorizedProjectId);
  }

  /**
   * GET /api/v1/manuscripts/pages/:pageId/deleted-files
   * GET /api/v1/manuscripts/docs/:pageId/deleted-files
   */
  @Get(['pages/:pageId/deleted-files', 'docs/:pageId/deleted-files'])
  @ApiOperation({ summary: 'Get list of deleted/trashed files in project' })
  async getDeletedFiles(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getDeletedFiles(pageId, authorizedProjectId);
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/restore
   * POST /api/v1/manuscripts/docs/:pageId/restore
   */
  @Post(['pages/:pageId/restore', 'docs/:pageId/restore'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a soft-deleted document or file' })
  async restorePage(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.restorePage(pageId, authorizedProjectId);
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/duplicate
   * POST /api/v1/manuscripts/pages/:pageId/clone
   * POST /api/v1/manuscripts/docs/:pageId/duplicate
   * POST /api/v1/manuscripts/docs/:pageId/clone
   */
  @Post([
    'pages/:pageId/duplicate',
    'pages/:pageId/clone',
    'docs/:pageId/duplicate',
    'docs/:pageId/clone',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Duplicate/clone a page by pageId with its content and tree node',
  })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.pageService.duplicatePage(pageId, authorizedProjectId, userId);
  }

  /**
   * Label management routes
   */
  @Get([
    'spaces/:spaceId/pages/:pageId/labels',
    'spaces/:spaceId/docs/:pageId/labels',
  ])
  async getPageLabels(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    return this.pageService.getPageLabels(spaceId, pageId);
  }

  @Post([
    'spaces/:spaceId/pages/:pageId/labels',
    'spaces/:spaceId/docs/:pageId/labels',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async assignPageLabels(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    return this.pageService.assignPageLabels(spaceId, pageId, body?.labelIds);
  }

  @Put([
    'spaces/:spaceId/pages/:pageId/labels',
    'spaces/:spaceId/docs/:pageId/labels',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async replacePageLabels(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    return this.assignPageLabels(spaceId, pageId, body);
  }

  @Delete([
    'spaces/:spaceId/pages/:pageId/labels/:labelId',
    'spaces/:spaceId/docs/:pageId/labels/:labelId',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async removePageLabel(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.pageService.removePageLabel(spaceId, pageId, labelId);
  }
}

/** @deprecated Use DocController */
export { DocController as PagesDocController };
