/**
 * modules/pages/docstore/controllers/page.controller.ts
 * Domain Controller handling Page aggregate lifecycle routes: thumbnails, files list,
 * cross-project import, project page creation/listing, trash/restore, clone, and labels.
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
import {
  PageService,
  CreatePageFileParams,
  ImportFromProjectParams,
  CreateProjectPageParams,
} from '@/modules/pages/core/services/page.service';

@ApiTags('Manuscripts - Pages Compatibility Bridge')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PageController {
  constructor(private readonly pageService: PageService) {}

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

  @Get(['spaces/:spaceId/pages', 'spaces/:spaceId/docs'])
  async getProjectPages(
    @Param('spaceId') spaceId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.pageService.getProjectPages(spaceId, { status, search });
  }

  @Delete(['pages/:pageId', 'docs/:pageId'])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async deletePage(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.deletePage(pageId, authorizedProjectId);
  }

  @Get(['pages/:pageId/deleted-files', 'docs/:pageId/deleted-files'])
  @ApiOperation({ summary: 'Get list of deleted/trashed files in project' })
  async getDeletedFiles(
    @Param('pageId') pageId: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.pageService.getDeletedFiles(pageId, authorizedProjectId);
  }

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
