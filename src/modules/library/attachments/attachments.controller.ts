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
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authorization';

@ApiTags('Library - Attachments & Annotations')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(
    private readonly annotationsService: AnnotationsService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  @Get(['annotations/:workspaceId/:itemId', ':workspaceId/:itemId'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all PDF annotations for a catalog item' })
  async getAnnotations(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.annotationsService.getAnnotations(workspaceId, itemId);
  }

  @Post(['annotations/:workspaceId/:itemId', ':workspaceId/:itemId'])
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
    'annotations/:workspaceId/:itemId/:annotationId',
    ':workspaceId/:itemId/:annotationId',
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
    'annotations/:workspaceId/:itemId/:annotationId',
    ':workspaceId/:itemId/:annotationId',
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

  @Get(['annotations/:workspaceId/:itemId/notes', ':workspaceId/:itemId/notes'])
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

  @Post('extract')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extract academic metadata from a PDF file URL',
  })
  async extractFromPdf(@Body() dto: ExtractPdfMetadataDto) {
    return this.attachmentsService.extractFromPdf(dto.fileUrl);
  }
}
