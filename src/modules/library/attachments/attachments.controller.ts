import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AttachmentsService } from './attachments.service';
import { WebSnapshotService } from './services/web-snapshot.service';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  CreateAttachmentDto,
  ReplaceAttachmentFileDto,
} from './dto/attachments.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { IStoragePort, STORAGE_PORT } from '../../storage/storage.port';

@Controller([
  'api/v1/library',
  'api/v1/projects/:projectId/library',
])
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly webSnapshotService: WebSnapshotService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  /**
   * Library Bounded Context Upload Gateway.
   * Frontend library uploads files through this gateway without directly referencing StorageModule.
   */
  @Post(['attachments/upload', 'upload', 'files/upload'])
  @HttpCode(HttpStatus.CREATED)
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!this.storagePort?.uploadFile) {
      throw new BadRequestException('Storage service is unavailable');
    }

    let buffer: Buffer | undefined;
    let filename = 'document.pdf';
    let mimeType = 'application/pdf';

    const parts = (req as any).parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        filename = part.filename || filename;
        mimeType = part.mimetype || mimeType;
      }
    }

    if (!buffer) {
      throw new BadRequestException(
        'No file payload received in multipart request',
      );
    }

    const uploaded = await this.storagePort.uploadFile({
      userId,
      filename,
      buffer,
      mimeType,
      source: 'library',
    });

    return {
      success: true,
      data: uploaded,
    };
  }

  /**
   * Stream / serve library file content scoped by access.
   */
  @Get(['attachments/files/:fileId/content', 'files/:fileId/content'])
  async streamLibraryFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Res() res: FastifyReply,
  ) {
    if (!this.storagePort?.readOwnedFile) {
      throw new NotFoundException('Storage port unavailable');
    }

    const fileRecord = await this.storagePort.readOwnedFile({
      fileId,
      userId,
    });

    res.header('Content-Type', fileRecord.mimeType || 'application/pdf');
    res.header(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(fileRecord.filename)}"`,
    );
    res.header('Content-Length', fileRecord.size);
    res.header(
      'Cache-Control',
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    return res.send(fileRecord.buffer);
  }

  /**
   * Stream / serve attachment content by attachment ID.
   */
  @Get('attachments/:attachmentId/content')
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
  ) {
    const result = await this.attachmentsService.getItemAttachment(
      userId,
      undefined,
      attachmentId,
    );
    const attachment = (result as any)?.attachment || result;

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort?.readOwnedFile) {
      const fileRecord = await this.storagePort.readOwnedFile({
        fileId: attachment.fileId,
        userId,
      });

      res.header(
        'Content-Type',
        fileRecord.mimeType || attachment.mimeType || 'application/pdf',
      );
      res.header(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(attachment.filename || fileRecord.filename)}"`,
      );
      res.header('Content-Length', fileRecord.size);
      return res.send(fileRecord.buffer);
    }

    if (attachment.url) {
      return res.redirect(attachment.url, 302);
    }

    throw new NotFoundException(
      'No content stream available for this attachment',
    );
  }

  @Get('items/:itemId/attachments')
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.attachmentsService.getItemAttachments(userId, itemId);
  }

  @Get(['attachments/:attachmentId', 'items/:itemId/attachments/:attachmentId'])
  async getItemAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
  ) {
    return this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
    );
  }

  @Post('items/:itemId/attachments')
  @HttpCode(HttpStatus.CREATED)
  async createAttachment(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachmentsService.createAttachment({
      ...dto,
      userId,
      itemId,
    });
  }

  @Get('attachments/:attachmentId/revisions')
  async getRevisions(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const revisions = await this.attachmentsService.getRevisions(
      userId,
      attachmentId,
    );
    return { revisions };
  }

  @Post('attachments/:attachmentId/revisions')
  @HttpCode(HttpStatus.CREATED)
  async addRevision(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: ReplaceAttachmentFileDto,
  ) {
    return this.attachmentsService.addRevision(userId, attachmentId, dto);
  }

  @Delete('attachments/:attachmentId')
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(userId, attachmentId);
  }

  @Post([
    'attachments/:attachmentId/set-primary',
    'items/:itemId/attachments/:attachmentId/set-primary',
  ])
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
  ) {
    const resolvedItemId = itemId || (await this.resolveAttachmentItemId(attachmentId));
    return this.attachmentsService.setPrimaryAttachment(
      userId,
      resolvedItemId,
      attachmentId,
    );
  }

  @Post('items/:itemId/attachments/snapshot')
  @HttpCode(HttpStatus.CREATED)
  async captureSnapshot(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() body?: { url?: string; title?: string },
  ) {
    let targetUrl = body?.url?.trim();
    if (!targetUrl) {
      const item = await this.prisma.item.findFirst({
        where: { id: itemId, userId, deletedAt: null },
        select: { url: true, title: true },
      });
      if (!item) {
        throw new NotFoundException(
          `Item ${itemId} not found`,
        );
      }
      if (!item.url) {
        throw new BadRequestException(
          'No URL found on this item to capture a snapshot.',
        );
      }
      targetUrl = item.url;
    }

    return this.webSnapshotService.captureAndAttach(
      targetUrl,
      itemId,
      userId,
      { title: body?.title },
    );
  }

  private async resolveAttachmentItemId(attachmentId: string): Promise<string> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { itemId: true },
    });
    if (!attachment?.itemId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    return attachment.itemId;
  }
}
