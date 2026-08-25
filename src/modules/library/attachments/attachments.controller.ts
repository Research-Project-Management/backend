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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AnnotationsService } from './annotations/annotations.service';
import { AttachmentsService } from './attachments.service';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  ExtractPdfMetadataDto,
} from './dto/attachments.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authz';

@ApiTags('Library - Attachments & Annotations')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(
    private readonly annotationsService: AnnotationsService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  @Get([
    'workspace/:workspaceId/library/items/:itemId/attachments',
    'library/:workspaceId/items/:itemId/attachments',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List attachments for a catalog item' })
  async getItemAttachments(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.attachmentsService.getItemAttachments(workspaceId, itemId);
  }

  @Get([
    'workspace/:workspaceId/library/items/:itemId/attachments/:attachmentId',
    'library/:workspaceId/items/:itemId/attachments/:attachmentId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get attachment details for a catalog item' })
  async getItemAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.getItemAttachment(
      workspaceId,
      itemId,
      attachmentId,
    );
  }

  @Get([
    'workspace/:workspaceId/library/items/:itemId/annotations',
    'library/attachments/annotations/:workspaceId/:itemId',
    'library/attachments/:workspaceId/:itemId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all PDF annotations for a catalog item' })
  async getAnnotations(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.annotationsService.getAnnotations(workspaceId, itemId);
  }

  @Post([
    'workspace/:workspaceId/library/items/:itemId/annotations',
    'library/attachments/annotations/:workspaceId/:itemId',
    'library/attachments/:workspaceId/:itemId',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary:
      'Create a new PDF annotation (highlight, underline, note, box) on an item',
  })
  async createAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateAnnotationDto,
  ) {
    return this.annotationsService.createAnnotation(
      workspaceId,
      itemId,
      userId,
      dto,
    );
  }

  @Put([
    'workspace/:workspaceId/library/items/:itemId/annotations/:annotationId',
    'library/attachments/annotations/:workspaceId/:itemId/:annotationId',
    'library/attachments/:workspaceId/:itemId/:annotationId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Update an existing PDF annotation comment or color',
  })
  async updateAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('annotationId') annotationId: string,
    @Body() dto: UpdateAnnotationDto,
  ) {
    return this.annotationsService.updateAnnotation(
      workspaceId,
      itemId,
      annotationId,
      dto,
    );
  }

  @Delete([
    'workspace/:workspaceId/library/items/:itemId/annotations/:annotationId',
    'library/attachments/annotations/:workspaceId/:itemId/:annotationId',
    'library/attachments/:workspaceId/:itemId/:annotationId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Delete a PDF annotation' })
  async deleteAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('annotationId') annotationId: string,
  ) {
    return this.annotationsService.deleteAnnotation(
      workspaceId,
      itemId,
      annotationId,
    );
  }

  @Get([
    'workspace/:workspaceId/library/items/:itemId/annotations/notes',
    'library/attachments/annotations/:workspaceId/:itemId/notes',
    'library/attachments/:workspaceId/:itemId/notes',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Extract Literature Notes markdown summary from all annotations on this item',
  })
  async extractLiteratureNotes(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.annotationsService.extractLiteratureNotes(workspaceId, itemId);
  }

  @Post([
    'workspace/:workspaceId/library/attachments/extract',
    'library/attachments/extract',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extract academic metadata from a PDF file URL',
  })
  async extractFromPdf(
    @Param('workspaceId') workspaceId: string | undefined,
    @Body() dto: ExtractPdfMetadataDto,
  ) {
    return this.attachmentsService.extractFromPdf(dto.fileUrl);
  }
}
