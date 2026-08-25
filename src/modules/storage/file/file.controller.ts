import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
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
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
  ProjectRoleGuard,
  ProjectRoles,
} from '@/modules/iam/authz';

@ApiTags('Storage & Assets')
@ApiBearerAuth('JWT-auth')
@Controller('api/files')
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for direct client upload' })
  async presign(@Body() dto: PresignDto) {
    return this.fileService.presign(dto);
  }

  /**
   * Multipart Upload endpoint streaming directly to Cloudflare R2 / S3.
   */
  @Post('upload-r2')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Multipart stream upload directly to R2/S3' })
  async uploadR2(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.uploadMultipartStream(req, userId);
  }

  /**
   * Serve / Stream R2 File by storage key
   */
  @Get('r2/*')
  @ApiOperation({ summary: 'Stream R2 stored file by storage key' })
  async getR2File(
    @Param('*') key: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!key) {
      throw new NotFoundException('Storage key is required');
    }

    const output = await this.fileService.getR2Stream(key);
    if (!output?.Body) {
      throw new NotFoundException('File not found in storage');
    }

    if (output.ContentType) {
      res.header('Content-Type', output.ContentType);
    }
    if (output.ContentLength) {
      res.header('Content-Length', output.ContentLength);
    }

    // Attach stream error safety to prevent uncaught error events if client closes connection early
    const streamBody = output.Body as {
      on?: (event: string, listener: (...args: any[]) => void) => void;
    };
    if (typeof streamBody?.on === 'function') {
      streamBody.on('error', () => {
        // Suppress stream error when client disconnects early
      });
    }

    return output.Body;
  }

  // â”€â”€ Workspace Scoped â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Post('workspace/:workspaceId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Upload file to workspace storage' })
  async uploadWorkspaceFile(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { workspaceId }, dto);
  }

  @Post('workspace/:workspaceId/folder')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Create folder in workspace' })
  async createWorkspaceFolder(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { workspaceId }, dto);
  }

  @Get('workspace/:workspaceId/home')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get workspace home/root files' })
  async getWorkspaceHome(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getHomeFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/all')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List all workspace files with optional parent filter' })
  async getWorkspaceAll(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  @Get('workspace/:workspaceId/my-files')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get files uploaded by current user in workspace' })
  async getWorkspaceMyFiles(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/starred')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get starred files in workspace' })
  async getWorkspaceStarred(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getStarredFiles(workspaceId);
  }

  @Get('workspace/:workspaceId/shared')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get files shared with current user in workspace' })
  async getWorkspaceShared(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, workspaceId);
  }

  @Get('workspace/:workspaceId/trash')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get trashed files in workspace' })
  async getWorkspaceTrash(@Param('workspaceId') workspaceId: string) {
    return this.fileService.getTrashedFiles(workspaceId);
  }

  @Get('workspace/:workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List workspace files by parent folder' })
  async getWorkspaceFiles(
    @Param('workspaceId') workspaceId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ workspaceId, parentId });
  }

  // â”€â”€ Project Scoped â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Post('project/:projectId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Upload file to project storage' })
  async uploadProjectFile(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { projectId }, dto);
  }

  @Post('project/:projectId/folder')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create folder in project' })
  async createProjectFolder(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { projectId }, dto);
  }

  @Get('project/:projectId/my-files')
  @ApiOperation({ summary: 'Get files uploaded by current user in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectMyFiles(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getMyFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/starred')
  @ApiOperation({ summary: 'Get starred files in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectStarred(@Param('projectId') projectId: string) {
    return this.fileService.getStarredFiles(undefined, projectId);
  }

  @Get('project/:projectId/shared')
  @ApiOperation({ summary: 'Get files shared with current user in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectShared(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getSharedFiles(userId, undefined, projectId);
  }

  @Get('project/:projectId/trash')
  @ApiOperation({ summary: 'Get trashed files in project' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectTrash(@Param('projectId') projectId: string) {
    return this.fileService.getTrashedFiles(undefined, projectId);
  }

  @Get('project/:projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List project files' })
  async getProjectFiles(
    @Param('projectId') projectId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ projectId, parentId });
  }

  // â”€â”€ Page Scoped â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @Post('page/:pageId/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Upload file attached to a page' })
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.fileService.upload(userId, { pageId }, dto);
  }

  @Post('page/:pageId/folder')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create folder in page' })
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  async createPageFolder(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.fileService.createFolder(userId, { pageId }, dto);
  }

  @Get('page/:pageId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List files attached to a page' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.fileService.getFiles({ pageId, parentId });
  }

  // â”€â”€ General File Operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  @ApiOperation({ summary: 'Upload a general file (workspace-level)' })
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

  @ApiOperation({ summary: 'Create a general folder' })
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
  @ApiOperation({ summary: 'Get file metadata by ID' })
  async getFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getFile(fileId, userId);
  }

  @Put(':fileId')
  @ApiOperation({ summary: 'Update file metadata' })
  async updateFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateFileDto,
  ) {
    return this.fileService.updateFile(fileId, userId, dto);
  }

  @Delete(':fileId')
  @ApiOperation({ summary: 'Move file to trash' })
  async deleteFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.deleteFile(fileId, userId);
  }
  @ApiOperation({ summary: 'Toggle star on file (alias)' })

  @Put(':fileId/star')
  async toggleStar(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.toggleStar(fileId, userId);
  }

  @Put(':fileId/restore')
  @ApiOperation({ summary: 'Restore file from trash' })
  async restoreFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.restoreFile(fileId, userId);
  }

  @Delete(':fileId/permanent')
  @ApiOperation({ summary: 'Permanently delete file from storage' })
  async permanentlyDeleteFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.permanentlyDeleteFile(fileId, userId);
  }

  @Put(':fileId/rename')
  @ApiOperation({ summary: 'Rename a file or folder' })
  async renameFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RenameFileDto,
  ) {
    return this.fileService.renameFile(
      fileId,
      userId,
      dto.filename || dto.name || 'Untitled',
    );
  }

  @Put(':fileId/move')
  @ApiOperation({ summary: 'Move file to a different folder' })
  async moveFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: MoveFileDto,
  ) {
    return this.fileService.moveFile(fileId, userId, dto.parentId);
  }

  @Put(':fileId/share')
  @ApiOperation({ summary: 'Share file with a workspace member' })
  async shareFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ShareFileDto,
  ) {
    return this.fileService.shareFile(fileId, userId, dto);
  }

  @Get(':fileId/share')
  @ApiOperation({ summary: 'Get share settings and permissions for a file' })
  async getShareSettings(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.fileService.getShareSettings(fileId, userId);
  }
}
