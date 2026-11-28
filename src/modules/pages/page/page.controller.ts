/**
 * modules/pages/page/page.controller.ts
 * Canonical REST controller for Page aggregate lifecycle:
 * project page CRUD, thumbnails, child files, cross-project import, trash/restore, duplicate, and labels.
 */

import {
  Controller,
  Get,
  Put,
  Patch,
  Post,
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
import { AuthenticatedRequest, isUuid } from '@/core';
import { PageService } from './services/page.service';
import {
  AssignPageLabelsDto,
  CreatePageFileDto,
  CreateProjectPageDto,
  ImportFileFromProjectDto,
  UpdatePageMetadataDto,
  UpdatePageThumbnailDto,
} from './dto/page.dto';

@ApiTags('Pages')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PageController {
  constructor(private readonly pageService: PageService) {}

  // ── Project Pages ───────────────────────────────────────────────────────────

  @Get('spaces/:spaceId/docs')
  @ApiOperation({ summary: 'List pages in a project space' })
  async getProjectPages(
    @Param('spaceId') spaceId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @ResolvedSpace() authorizedSpaceId?: string | null,
  ) {
    const effectiveSpaceId =
      authorizedSpaceId && isUuid(authorizedSpaceId)
        ? authorizedSpaceId
        : spaceId;
    return this.pageService.getProjectPages(effectiveSpaceId, { status, search });
  }

  @Post('spaces/:spaceId/docs')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new page in a project space' })
  async createProjectPage(
    @Param('spaceId') spaceId: string,
    @Body() body: CreateProjectPageDto,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authorizedSpaceId?: string | null,
  ) {
    const effectiveSpaceId =
      authorizedSpaceId && isUuid(authorizedSpaceId)
        ? authorizedSpaceId
        : spaceId;
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.pageService.createProjectPage(effectiveSpaceId, body, userId);
  }

  // ── Page Metadata & Thumbnail ───────────────────────────────────────────────

  @Patch('docs/:pageId/metadata')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update page title, description, or status' })
  async updateMetadata(
    @Param('pageId') pageId: string,
    @Body() body: UpdatePageMetadataDto,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.updatePageMetadata(
      pageId,
      body,
      authorizedProjectId,
    );
  }

  @Put('docs/:pageId/thumbnail')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update rendered PDF thumbnail for a page' })
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() body: UpdatePageThumbnailDto,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.updateThumbnail(
      pageId,
      body?.pdfThumbnail || '',
      authorizedProjectId,
    );
  }

  // ── Page Files & Cross-Project Import ───────────────────────────────────────

  @Get('docs/:pageId/files')
  @ApiOperation({ summary: 'List files belonging to a page' })
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

  @Post('docs/:pageId/files')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a child text file inside a page' })
  async createPageFile(
    @Param('pageId') pageId: string,
    @Body() body: CreatePageFileDto,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.createPageFile(pageId, body, authorizedProjectId);
  }

  @Post('spaces/:spaceId/files/import-from-project')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Import a document or binary file from another project',
  })
  async importFileFromProject(
    @Param('spaceId') spaceId: string,
    @Body() body: ImportFileFromProjectDto,
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

  // ── Trash, Restore, Purge & Duplicate ───────────────────────────────────────

  @Get('spaces/:spaceId/trash')
  @ApiOperation({ summary: 'List soft-deleted pages in a project space trash' })
  async getTrashPages(
    @Param('spaceId') spaceId: string,
    @ResolvedSpace() authorizedSpaceId?: string | null,
  ) {
    const effectiveSpaceId =
      authorizedSpaceId && isUuid(authorizedSpaceId)
        ? authorizedSpaceId
        : spaceId;
    return this.pageService.getTrashPages(effectiveSpaceId);
  }

  @Delete('docs/:pageId')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a page or child file (move to trash)' })
  async deletePage(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.deletePage(pageId, authorizedProjectId);
  }

  @Delete('docs/:pageId/permanent')
  @RequireRole(Role.COORDINATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Permanently delete a page and reclaim CAS blobs & storage quota',
  })
  async purgePagePermanently(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.purgePagePermanently(pageId, authorizedProjectId);
  }

  @Get('docs/:pageId/deleted-files')
  @ApiOperation({ summary: 'List soft-deleted files in a page/project' })
  async getDeletedFiles(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getDeletedFiles(pageId, authorizedProjectId);
  }

  @Post('docs/:pageId/restore')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a soft-deleted page or file' })
  async restorePage(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.restorePage(pageId, authorizedProjectId);
  }

  @Post('docs/:pageId/duplicate')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Duplicate a page with its content and tree node' })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.pageService.duplicatePage(pageId, authorizedProjectId, userId);
  }

  // ── Page Labels ─────────────────────────────────────────────────────────────

  @Get('spaces/:spaceId/docs/:pageId/labels')
  @ApiOperation({ summary: 'List labels assigned to a page' })
  async getPageLabels(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    return this.pageService.getPageLabels(spaceId, pageId);
  }

  @Post('spaces/:spaceId/docs/:pageId/labels')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Assign labels to a page' })
  async assignPageLabels(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body() body: AssignPageLabelsDto,
  ) {
    return this.pageService.assignPageLabels(spaceId, pageId, body?.labelIds);
  }

  @Put('spaces/:spaceId/docs/:pageId/labels')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Replace labels assigned to a page' })
  async replacePageLabels(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Body() body: AssignPageLabelsDto,
  ) {
    return this.pageService.assignPageLabels(spaceId, pageId, body?.labelIds);
  }

  @Delete('spaces/:spaceId/docs/:pageId/labels/:labelId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Remove a label from a page' })
  async removePageLabel(
    @Param('spaceId') spaceId: string,
    @Param('pageId') pageId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.pageService.removePageLabel(spaceId, pageId, labelId);
  }
}
