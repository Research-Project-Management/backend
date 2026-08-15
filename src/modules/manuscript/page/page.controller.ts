import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PageService } from './page.service';
import {
  CreatePageDto,
  UpdatePageDto,
  SetMainFileDto,
  UpdateThumbnailDto,
} from './dto/page.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Manuscript')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class PageController {
  constructor(private readonly pageService: PageService) {}

  @Get('workspace/:workspaceId/pages')
  async getWorkspacePages(@Param('workspaceId') workspaceId: string) {
    return this.pageService.getWorkspacePages(workspaceId);
  }

  @Get('project/:projectId/pages')
  async getProjectPages(@Param('projectId') projectId: string) {
    return this.pageService.getProjectPages(projectId);
  }

  @Post('project/:projectId/pages')
  @HttpCode(HttpStatus.CREATED)
  async createPage(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageDto,
  ) {
    return this.pageService.createPage('', projectId, userId, dto);
  }

  @Get(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  async getPage(@Param('pageId') pageId: string) {
    return this.pageService.getPage(pageId);
  }

  @Put(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  async updatePage(
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pageService.updatePage(pageId, dto);
  }

  @Delete(['project/:projectId/pages/:pageId', 'pages/:pageId'])
  async deletePage(@Param('pageId') pageId: string) {
    return this.pageService.deletePage(pageId);
  }

  @Post([
    'project/:projectId/pages/:pageId/duplicate',
    'pages/:pageId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  async duplicatePage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.pageService.duplicatePage(pageId, userId);
  }

  @Get('pages/:pageId/files')
  async getChildPages(@Param('pageId') pageId: string) {
    return this.pageService.getChildPages(pageId);
  }

  @Post('pages/:pageId/files')
  @HttpCode(HttpStatus.CREATED)
  async createChildPage(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePageDto,
  ) {
    return this.pageService.createChildPage(pageId, userId, dto);
  }

  @Put([
    'project/:projectId/pages/:pageId/main-file',
    'pages/:pageId/main-file',
  ])
  async setMainFile(
    @Param('pageId') pageId: string,
    @Body() dto: SetMainFileDto,
  ) {
    return this.pageService.setMainFile(pageId, dto.mainFileId);
  }

  @Put([
    'project/:projectId/pages/:pageId/thumbnail',
    'pages/:pageId/thumbnail',
  ])
  async updateThumbnail(
    @Param('pageId') pageId: string,
    @Body() dto: UpdateThumbnailDto,
  ) {
    return this.pageService.updateThumbnail(pageId, dto.pdfThumbnail);
  }
}
