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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileService } from './file.service';
import {
  PresignDto,
  UploadFileDto,
  CreateFolderDto,
  UpdateFileDto,
  RenameFileDto,
  MoveFileDto,
  ShareFileDto,
} from './dto/file.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Storage')
@ApiBearerAuth('JWT-auth')
@Controller('api/files')
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  async presign(@Body() dto: PresignDto) {
    return this.fileService.presign(dto);
  }

  // ── Workspace Scoped ────────────────────────────────────────────────────────

  @Post('workspace/:workspaceId/upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadWorkspaceFile(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { workspaceId }, dto);
  }

  @Post('workspace/:workspaceId/folder')
  @HttpCode(HttpStatus.CREATED)
  async createWorkspaceFolder(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { workspaceId }, dto);
  }

  @Get('workspace/:workspaceId/home')
  async getWorkspaceHome(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getHomeFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/all')
  async getWorkspaceAll(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  @Get('workspace/:workspaceId/my-files')
  async getWorkspaceMyFiles(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/starred')
  async getWorkspaceStarred(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getStarredFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/shared')
  async getWorkspaceShared(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/trash')
  async getWorkspaceTrash(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getTrashedFiles(workspaceId);
  }

  @Get('workspace/:workspaceId')
  async getWorkspaceFiles(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  // ── Project Scoped ──────────────────────────────────────────────────────────

  @Post('project/:projectId/upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadProjectFile(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { projectId }, dto);
  }

  @Post('project/:projectId/folder')
  @HttpCode(HttpStatus.CREATED)
  async createProjectFolder(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { projectId }, dto);
  }

  @Get('project/:projectId/my-files')
  async getProjectMyFiles(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/starred')
  async getProjectStarred(@Param('projectId') projectId: string) {
    return this.fileService.getStarredFiles(undefined, projectId);
  }

  @Get('project/:projectId/shared')
  async getProjectShared(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/trash')
  async getProjectTrash(@Param('projectId') projectId: string) {
    return this.fileService.getTrashedFiles(undefined, projectId);
  }

  @Get('project/:projectId')
  async getProjectFiles(
    @Param('projectId') projectId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ projectId, parentId });
  }

  // ── Page Scoped ────────────────────────────────────────────────────────────

  @Post('page/:pageId/upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { pageId }, dto);
  }

  @Post('page/:pageId/folder')
  @HttpCode(HttpStatus.CREATED)
  async createPageFolder(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { pageId }, dto);
  }

  @Get('page/:pageId')
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ pageId, parentId });
  }

  // ── General File Operations ────────────────────────────────────────────────

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  async uploadGeneralFile(
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(
      userId,
      {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        pageId: dto.pageId,
      },
      dto,
    );
  }

  @Post('folder')
  @HttpCode(HttpStatus.CREATED)
  async createGeneralFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(
      userId,
      {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        pageId: dto.pageId,
      },
      dto,
    );
  }

  @Get(':fileId')
  async getFile(@Param('fileId') fileId: string) {
    return this.fileService.getFile(fileId);
  }

  @Put(':fileId')
  async updateFile(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateFileDto,
  ) {
    return this.fileService.updateFile(fileId, dto);
  }

  @Delete(':fileId')
  async deleteFile(@Param('fileId') fileId: string) {
    return this.fileService.deleteFile(fileId);
  }

  @Put(':fileId/star')
  async toggleStar(@Param('fileId') fileId: string) {
    return this.fileService.toggleStar(fileId);
  }

  @Put(':fileId/restore')
  async restoreFile(@Param('fileId') fileId: string) {
    return this.fileService.restoreFile(fileId);
  }

  @Delete(':fileId/permanent')
  async permanentlyDeleteFile(@Param('fileId') fileId: string) {
    return this.fileService.permanentlyDeleteFile(fileId);
  }

  @Put(':fileId/rename')
  async renameFile(
    @Param('fileId') fileId: string,
    @Body() dto: RenameFileDto,
  ) {
    return this.fileService.renameFile(
      fileId,
      dto.filename || dto.name || 'Untitled',
    );
  }

  @Put(':fileId/move')
  async moveFile(@Param('fileId') fileId: string, @Body() dto: MoveFileDto) {
    return this.fileService.moveFile(fileId, dto.parentId);
  }

  @Put(':fileId/share')
  async shareFile(@Param('fileId') fileId: string, @Body() dto: ShareFileDto) {
    return this.fileService.shareFile(fileId, dto);
  }
}
