import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import {
  PresignUploadDto,
  CompletePresignDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
} from '@/modules/library/extraction/dto/attachments.dto';
import { BaseAttachmentStorageController } from './attachment-storage.controller';

/**
 * Project Library Storage Controller (/api/v1/projects/:projectId/library).
 * Validates project UUID & enforces project roles.
 */
@ApiTags('Library Attachments - Project Storage Gateway')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectAttachmentStorageController extends BaseAttachmentStorageController {
  constructor(
    @Inject(STORAGE_PORT)
    storagePort: IStoragePort,
    attachmentsService: AttachmentsService,
  ) {
    super(storagePort, attachmentsService);
  }

  @Post(['attachments/upload', 'upload', 'files/upload'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Upload binary file directly via multipart stream to project library',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeUploadLibraryFile(userId, req, projectId);
  }

  @Post([
    'attachments/presign-upload',
    'attachments/presign',
    'files/presign-upload',
    'files/presign',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Obtain presigned upload URL for direct S3 upload' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async presignUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: PresignUploadDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executePresignUpload(userId, dto, projectId);
  }

  @Post([
    'attachments/complete-upload',
    'attachments/presign/complete',
    'files/complete-upload',
    'files/presign/complete',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete and verify presigned S3 upload' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async completePresignedUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeCompletePresignedUpload(userId, dto, projectId);
  }

  @Post(['attachments/multipart/initiate', 'files/multipart/initiate'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate S3 multipart upload session' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: InitiateMultipartDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeInitiateMultipart(userId, dto, projectId);
  }

  @Get([
    'attachments/multipart/:sessionId/part-url',
    'files/multipart/:sessionId/part-url',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get presigned URL for specific S3 multipart chunk',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumber: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetMultipartPartUrl(
      userId,
      sessionId,
      partNumber,
      projectId,
    );
  }

  @Post(['attachments/multipart/complete', 'files/multipart/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete S3 multipart upload session' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeCompleteMultipart(userId, dto, projectId);
  }

  @Delete(['attachments/multipart/:sessionId', 'files/multipart/:sessionId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Abort S3 multipart upload session' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeAbortMultipart(userId, sessionId, projectId);
  }

  @Get(['files/:fileId', 'files/:fileId/content'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Stream binary content directly by fileId' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async streamLibraryFile(
    @CurrentUser('id') userId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeStreamLibraryFile(fileId, userId, res, projectId);
  }

  @Get('attachments/:attachmentId/presigned-url')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get direct S3 presigned URL for downloading project attachment',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getAttachmentPresignedUrl(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetAttachmentPresignedUrl(
      userId,
      attachmentId,
      projectId,
    );
  }

  @Get([
    'attachments/:attachmentId/content',
    'items/:itemId/attachments/:attachmentId/content',
    'attachments/:attachmentId/pdf',
    'items/:itemId/attachments/:attachmentId/pdf',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Stream project attachment binary content with byte-range support',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeStreamAttachmentContent(
      userId,
      attachmentId,
      req,
      res,
      projectId,
    );
  }
}
