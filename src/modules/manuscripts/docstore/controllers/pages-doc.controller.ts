/**
 * modules/manuscripts/docstore/controllers/pages-doc.controller.ts
 * Thin Domain Controller handling Document CRUD, Files, Trash/Restore,
 * Duplicate/Clone, Project Pages, and Labels.
 * Delegates aggregate lifecycle and business logic to ManuscriptPageService.
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
  UseGuards,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import { DocstoreService } from '../docstore.service';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import {
  ManuscriptPageService,
  UpdatePageContentParams,
  CreatePageFileParams,
  CreateProjectPageParams,
  PageDocRanges,
} from '@/modules/manuscripts/core/services/manuscript-page.service';

export type { PageDocRanges };

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PagesDocController {
  constructor(
    private readonly pageService: ManuscriptPageService,
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(forwardRef(() => StructureService))
    private readonly structureService?: StructureService,
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getPageById(pageId, authorizedProjectId);
  }

  /**
   * PUT /api/v1/manuscripts/pages/:pageId
   * PUT /api/v1/manuscripts/docs/:pageId
   */
  @Put(['pages/:pageId', 'docs/:pageId'])
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Update document content by pageId' })
  async updatePageContent(
    @Param('pageId') pageId: string,
    @Body() body: UpdatePageContentParams,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.updatePageContent(
      pageId,
      body,
      authorizedProjectId,
    );
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
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
  @Get(['pages/:pageId/files', 'docs/:pageId/files'])
  async getPageFiles(
    @Param('pageId') pageId: string,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getPageFiles(pageId, authorizedProjectId);
  }

  /**
   * POST /api/v1/manuscripts/pages/:pageId/files
   * POST /api/v1/manuscripts/docs/:pageId/files
   */
  @Post(['pages/:pageId/files', 'docs/:pageId/files'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createPageFile(
    @Param('pageId') pageId: string,
    @Body() body: CreatePageFileParams,
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.createPageFile(
      pageId,
      body,
      authorizedProjectId,
    );
  }

  // ─── 2. PROJECT PAGES CRUD & LABELS ──────────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/projects/:projectId/pages
   * POST /api/v1/manuscripts/projects/:projectId/docs
   */
  @Post(['projects/:projectId/pages', 'projects/:projectId/docs'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  async createProjectPage(
    @Param('projectId') projectId: string,
    @Body() body: CreateProjectPageParams,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.pageService.createProjectPage(projectId, body, userId);
  }

  /**
   * GET /api/v1/manuscripts/projects/:projectId/pages
   * GET /api/v1/manuscripts/projects/:projectId/docs
   */
  @Get(['projects/:projectId/pages', 'projects/:projectId/docs'])
  async getProjectPages(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.pageService.getProjectPages(projectId, { status, search });
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
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
    @ResolvedProject() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.duplicatePage(pageId, authorizedProjectId);
  }

  /**
   * Label management routes
   */
  @Get([
    'projects/:projectId/pages/:pageId/labels',
    'projects/:projectId/docs/:pageId/labels',
  ])
  async getPageLabels(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
  ) {
    return this.pageService.getPageLabels(projectId, pageId);
  }

  @Post([
    'projects/:projectId/pages/:pageId/labels',
    'projects/:projectId/docs/:pageId/labels',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async assignPageLabels(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    return this.pageService.assignPageLabels(
      projectId,
      pageId,
      body?.labelIds,
    );
  }

  @Put([
    'projects/:projectId/pages/:pageId/labels',
    'projects/:projectId/docs/:pageId/labels',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async replacePageLabels(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Body() body: { labelIds?: string[] },
  ) {
    return this.assignPageLabels(projectId, pageId, body);
  }

  @Delete([
    'projects/:projectId/pages/:pageId/labels/:labelId',
    'projects/:projectId/docs/:pageId/labels/:labelId',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  async removePageLabel(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.pageService.removePageLabel(projectId, pageId, labelId);
  }
}
