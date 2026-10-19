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
import { AnnotationType } from '@/modules/library/extraction/types/annotations.types';
import { PdfAnnotationImporterService } from '@/modules/library/extraction/services/pdf-annotation-importer.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  BatchAnnotationsDto,
} from '@/modules/library/extraction/dto/annotations.dto';
import { ProjectAccessGuard, ProjectRoles, ProjectRole } from '@/modules/project/access';
import { AnnotationsService } from '@/modules/library/extraction/services/annotations.service';

@ApiTags('Annotations')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/attachments/:attachmentId/annotations',
  'api/v1/projects/:projectId/library/attachments/:attachmentId/annotations',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class AnnotationsController {
  constructor(
    private readonly annotationsService: AnnotationsService,
    private readonly pdfAnnotationImporterService: PdfAnnotationImporterService,
  ) {}

  // GET /

  @Get()
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
    ProjectRole.REVIEWER,
  )
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
    @Param('projectId') projectId?: string,
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

    if (projectId !== undefined) {
      return this.annotationsService.getAnnotationsByAttachment(
        userId,
        attachmentId,
        pageIndex,
        type,
        projectId,
      );
    }

    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
      pageIndex,
      type,
    );
  }

  // POST /

  @Post()
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an annotation' })
  async createAnnotation(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: CreateAnnotationDto,
    @Param('projectId') projectId?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException(
        'Authentication required to create annotations',
      );
    }

    const createData = {
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
    };

    if (projectId !== undefined) {
      return this.annotationsService.createAnnotation(
        userId,
        createData,
        projectId,
      );
    }

    return this.annotationsService.createAnnotation(userId, createData);
  }

  // PATCH /:id

  @Patch(':id')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @ApiOperation({
    summary:
      'Update an annotation (optimistic lock via If-Match or expectedVersion)',
  })
  @ApiParam({ name: 'id', description: 'Annotation UUID' })
  async updateAnnotation(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') _attachmentId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateAnnotationDto,
    @Param('projectId') projectId?: string,
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

    if (projectId !== undefined) {
      return this.annotationsService.updateAnnotation(
        userId,
        id,
        rawVersion,
        updateData,
        projectId,
      );
    }

    return this.annotationsService.updateAnnotation(
      userId,
      id,
      rawVersion,
      updateData,
    );
  }

  // DELETE /:id

  @Delete(':id')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @ApiOperation({ summary: 'Soft-delete an annotation' })
  @ApiParam({ name: 'id', description: 'Annotation UUID' })
  async deleteAnnotation(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') _attachmentId: string,
    @Param('id') id: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Param('projectId') projectId?: string,
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

    const deleted =
      projectId !== undefined
        ? await this.annotationsService.deleteAnnotation(
            userId,
            id,
            expectedVersion,
            projectId,
          )
        : await this.annotationsService.deleteAnnotation(
            userId,
            id,
            expectedVersion,
          );

    if (!deleted) throw new NotFoundException(`Annotation ${id} not found`);
    return { id, deleted: true };
  }

  @Put('batch')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @ApiOperation({
    summary:
      'Batch upsert/delete annotations (max 200 items, single transaction)',
  })
  async batchUpsertAnnotations(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: BatchAnnotationsDto,
    @Param('projectId') projectId?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (projectId !== undefined) {
      return this.annotationsService.batchUpsertAnnotations(
        userId,
        attachmentId,
        { upserts: body.upserts, deletes: body.deletes },
        projectId,
      );
    }

    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      { upserts: body.upserts, deletes: body.deletes },
    );
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @ApiOperation({
    summary:
      'Batch upsert/delete annotations via POST (alias for PUT /batch)',
  })
  async batchUpsertAnnotationsPost(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: BatchAnnotationsDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.batchUpsertAnnotations(userId, attachmentId, body, projectId);
  }

  // POST /import-external

  @Post('import-external')
  @ProjectRoles(
    ProjectRole.OWNER,
    ProjectRole.COORDINATOR,
    ProjectRole.CONTRIBUTOR,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import annotations from underlying PDF (/Annots dictionary)',
  })
  async importExternalAnnotations(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (projectId !== undefined) {
      return this.pdfAnnotationImporterService.importFromAttachment(
        userId,
        attachmentId,
        projectId,
      );
    }

    return this.pdfAnnotationImporterService.importFromAttachment(
      userId,
      attachmentId,
    );
  }
}
