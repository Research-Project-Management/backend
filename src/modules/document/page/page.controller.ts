import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PageService } from './page.service';
import {
  CreatePageDto,
  UpdatePageDto,
  SetMainFileDto,
  UpdateThumbnailDto,
  CreatePageFileDto,
} from './dto/page.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Document - Page')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class PageController {
  constructor(private readonly pageService: PageService) {}

  @Get('projects/:projectId/pages')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all pages/documents in a project' })
  async getProjectPages(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.pageService.getProjectPages(projectId, status, search);
  }

  @Get('projects/:projectId/pages/tree')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get ordered document tree hierarchy for a project',
  })
  async getProjectPageTree(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPageTree(projectId);
  }

  @Post(['pages', 'projects/:projectId/pages'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new page/document in a project' })
  async createPage(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageDto,
    @Param('projectId') projectId?: string,
  ) {
    const effectiveProjectId = projectId || dto.projectId || '';
    return this.pageService.createPage(effectiveProjectId, userId, dto);
  }

  @Get(['pages/:pageId', 'projects/:projectId/pages/:pageId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a single page/document by ID' })
  async getPage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getPage(pageId, projectId);
  }

  @Put(['pages/:pageId', 'projects/:projectId/pages/:pageId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update page/document content or metadata' })
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.updatePage(pageId, dto, projectId, userId);
  }

  @Delete(['pages/:pageId', 'projects/:projectId/pages/:pageId'])
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Soft delete a page/document' })
  async deletePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.deletePage(pageId, projectId, userId);
  }

  @Post(['pages/:pageId/restore', 'projects/:projectId/pages/:pageId/restore'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore a soft-deleted page/document' })
  async restorePage(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.restorePage(pageId, projectId);
  }

  @Post([
    'pages/:pageId/duplicate',
    'projects/:projectId/pages/:pageId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing page/document' })
  async duplicatePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.duplicatePage(pageId, userId, projectId);
  }

  @Get(['pages/:pageId/files', 'projects/:projectId/pages/:pageId/files'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List files attached to a page/document' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getPageFiles(pageId, projectId);
  }

  @Get([
    'pages/:pageId/deleted-files',
    'projects/:projectId/pages/:pageId/deleted-files',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List soft-deleted files attached to a page/project' })
  async getDeletedFiles(
    @Param('pageId') pageId: string,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.getDeletedFiles(pageId, projectId);
  }

  @Post(['pages/:pageId/files', 'projects/:projectId/pages/:pageId/files'])
  @HttpCode(HttpStatus.CREATED)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a sub-file (child page) within a page' })
  async createPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageFileDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.createPageFile(pageId, userId, dto, projectId);
  }

  @Put([
    'pages/:pageId/main-file',
    'projects/:projectId/pages/:pageId/main-file',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Set the main/root file of a page' })
  async setMainFile(
    @Param('pageId') pageId: string,
    @Body() dto: SetMainFileDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.setMainFile(pageId, dto.mainFileId, projectId);
  }

  @Put([
    'pages/:pageId/thumbnail',
    'projects/:projectId/pages/:pageId/thumbnail',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update page PDF thumbnail' })
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() dto: UpdateThumbnailDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.pageService.updateThumbnail(
      pageId,
      dto.pdfThumbnail,
      projectId,
    );
  }

  @Get(['pages/:pageId/labels', 'projects/:projectId/pages/:pageId/labels'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get labels assigned to a page' })
  async getPageLabels(@Param('pageId') pageId: string) {
    return this.pageService.getPageLabels(pageId);
  }

  @Post(['pages/:pageId/labels', 'projects/:projectId/pages/:pageId/labels'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign labels to a page (adds, does not replace)' })
  async assignPageLabels(
    @Param('pageId') pageId: string,
    @Body() body: { labelIds: string[] },
  ) {
    return this.pageService.assignLabels(pageId, body.labelIds);
  }

  @Put(['pages/:pageId/labels', 'projects/:projectId/pages/:pageId/labels'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Replace all labels on a page' })
  async replacePageLabels(
    @Param('pageId') pageId: string,
    @Body() body: { labelIds: string[] },
  ) {
    return this.pageService.replaceLabels(pageId, body.labelIds);
  }

  @Delete(['pages/:pageId/labels/:labelId', 'projects/:projectId/pages/:pageId/labels/:labelId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Remove a label from a page' })
  async removePageLabel(
    @Param('pageId') pageId: string,
    @Param('labelId') labelId: string,
  ) {
    return this.pageService.removeLabel(pageId, labelId);
  }
}
