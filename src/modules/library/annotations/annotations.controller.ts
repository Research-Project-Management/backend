import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Put,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AnnotationType } from '@prisma/client';
import { AnnotationsService } from './annotations.service';
import { PdfAnnotationImporterService } from './services/pdf-annotation-importer.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  BatchAnnotationsDto,
} from './dto/annotations.dto';

@ApiTags('Annotations')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/attachments/:attachmentId/annotations',
  'api/v1/projects/:projectId/library/attachments/:attachmentId/annotations',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AnnotationsController {
  constructor(
    private readonly annotationsService: AnnotationsService,
    private readonly pdfAnnotationImporterService: PdfAnnotationImporterService,
  ) {}

  // ─── GET / ─────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'List annotations for an attachment, sorted by position',
  })
  @ApiQuery({ name: 'pageIndex', required: false, type: Number })
  @ApiQuery({ name: 'type', required: false, enum: AnnotationType })
  async listAnnotations(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('pageIndex') pageIndexRaw?: string,
    @Query('type') type?: AnnotationType,
  ) {
    let pageIndex: number | undefined;
    if (pageIndexRaw !== undefined) {
      pageIndex = parseInt(pageIndexRaw, 10);
      if (isNaN(pageIndex) || pageIndex < 0) {
        throw new BadRequestException(
          'pageIndex must be a non-negative integer',
        );
      }
    }

    if (type !== undefined && !Object.values(AnnotationType).includes(type)) {
      throw new BadRequestException(
        `type must be one of: ${Object.values(AnnotationType).join(', ')}`,
      );
    }

    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
      pageIndex,
      type,
    );
  }

  // ─── POST / ────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an annotation' })
  async createAnnotation(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: CreateAnnotationDto,
  ) {
    if (!userId) {
      throw new UnauthorizedException(
        'Authentication required to create annotations',
      );
    }
    return this.annotationsService.createAnnotation(userId, {
      attachmentId,
      type: body.type,
      pageIndex: body.pageIndex,
      y: body.y,
      x: body.x,
      color: body.color,
      quoteText: body.quoteText,
      comment: body.comment,
      rectCoords: body.rectCoords,
      authorId: userId,
    });
  }

  // ─── PATCH /:id ────────────────────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update an annotation (optimistic lock via If-Match or expectedVersion)',
  })
  @ApiParam({ name: 'id', description: 'Annotation UUID' })
  async updateAnnotation(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateAnnotationDto,
  ) {
    const rawVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/['"]/g, ''), 10) : undefined);

    if (rawVersion === undefined || isNaN(rawVersion) || rawVersion < 1) {
      throw new BadRequestException(
        'Optimistic locking required: provide expectedVersion (>= 1) or If-Match header',
      );
    }

    const { expectedVersion: _, ...updateData } = body;
    return this.annotationsService.updateAnnotation(
      userId,
      id,
      rawVersion,
      updateData,
    );
  }

  // ─── DELETE /:id ───────────────────────────────────────────────────────────

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an annotation' })
  @ApiParam({ name: 'id', description: 'Annotation UUID' })
  async deleteAnnotation(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('id') id: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    let expectedVersion: number | undefined;
    if (expectedVersionQuery !== undefined) {
      expectedVersion = parseInt(expectedVersionQuery, 10);
      if (isNaN(expectedVersion) || expectedVersion < 1) {
        throw new BadRequestException(
          'expectedVersion must be a positive integer',
        );
      }
    } else if (ifMatch) {
      expectedVersion = parseInt(ifMatch.replace(/['"]/g, ''), 10);
      if (isNaN(expectedVersion) || expectedVersion < 1) {
        throw new BadRequestException(
          'If-Match header must be a positive integer',
        );
      }
    }

    const deleted = await this.annotationsService.deleteAnnotation(
      userId,
      id,
      expectedVersion,
    );

    if (!deleted) throw new NotFoundException(`Annotation ${id} not found`);
    return { id, deleted: true };
  }

  // ─── PUT /batch ────────────────────────────────────────────────────────────

  @Put('batch')
  @ApiOperation({
    summary:
      'Batch upsert/delete annotations (max 200 items, single transaction)',
  })
  async batchUpsertAnnotations(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: BatchAnnotationsDto,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      { upserts: body.upserts, deletes: body.deletes },
    );
  }

  // ─── POST /import-external ──────────────────────────────────────────────────

  @Post('import-external')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import annotations from underlying PDF (/Annots dictionary)',
  })
  async importExternalAnnotations(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.pdfAnnotationImporterService.importFromAttachment(
      userId,
      attachmentId,
    );
  }
}
