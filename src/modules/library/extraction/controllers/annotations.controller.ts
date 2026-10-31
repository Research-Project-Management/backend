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
import { AnnotationType } from '@/modules/library/extraction/types/extraction.types';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { PdfAnnotationImporterService } from '@/modules/library/extraction/services/pdf-annotation-importer.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  BatchAnnotationsDto,
  normalizeAnnotationType,
} from '@/modules/library/extraction/dto/annotations.dto';
import {
  ProjectAccessGuard,
  ProjectRoles,
  ProjectRole,
} from '@/modules/project/access';
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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

    const normalizedType =
      type !== undefined ? normalizeAnnotationType(type) : undefined;
    if (
      normalizedType !== undefined &&
      !Object.values(AnnotationType).includes(normalizedType)
    ) {
      throw new BadRequestException(
        `type must be one of: ${Object.values(AnnotationType).join(', ')}`,
      );
    }

    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    if (projectId !== undefined) {
      return this.annotationsService.getAnnotationsByAttachment(
        userId,
        attachmentId,
        pageIndex,
        normalizedType,
        projectId,
      );
    }

    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
      pageIndex,
      normalizedType,
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException(
        'Authentication required to create annotations',
      );
    }

    const createData = {
      ...(body.id ? { id: body.id } : {}),
      attachmentId,
      type: body.type,
      pageIndex: body.pageIndex,
      y: body.y,
      x: body.x,
      color: body.color,
      quoteText: body.quoteText ?? body.text,
      comment: body.comment,
      tags: body.tags,
      rectCoords:
        body.rectCoords ??
        body.rects ??
        (body.boundingRect ? [body.boundingRect] : undefined),
      authorId: userId,
    };

    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

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
    @Param('attachmentId') attachmentId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateAnnotationDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const rawVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/['"]/g, ''), 10) : undefined);

    if (rawVersion === undefined || isNaN(rawVersion) || rawVersion < 1) {
      throw new BadRequestException(
        'Optimistic locking required: provide expectedVersion (>= 1) or If-Match header',
      );
    }

    const {
      expectedVersion: _,
      text,
      rects,
      boundingRect,
      ...restUpdateData
    } = body;

    const updateData = {
      ...restUpdateData,
      ...(restUpdateData.quoteText === undefined && text !== undefined
        ? { quoteText: text }
        : {}),
      ...(restUpdateData.rectCoords === undefined &&
      (rects !== undefined || boundingRect !== undefined)
        ? { rectCoords: rects ?? (boundingRect ? [boundingRect] : undefined) }
        : {}),
    };

    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    return this.annotationsService.updateAnnotation(
      userId,
      id,
      rawVersion,
      updateData,
      projectId,
      attachmentId,
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
    @Param('attachmentId') attachmentId: string,
    @Param('id') id: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
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

    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    const deleted = await this.annotationsService.deleteAnnotation(
      userId,
      id,
      expectedVersion,
      projectId,
      attachmentId,
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    const normalizedUpserts = (body.upserts ?? []).map((u) => ({
      ...u,
      quoteText: u.quoteText ?? u.text,
      rectCoords:
        u.rectCoords ?? u.rects ?? (u.boundingRect ? [u.boundingRect] : undefined),
    }));

    if (projectId !== undefined) {
      return this.annotationsService.batchUpsertAnnotations(
        userId,
        attachmentId,
        { upserts: normalizedUpserts, deletes: body.deletes },
        projectId,
      );
    }

    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      { upserts: normalizedUpserts, deletes: body.deletes },
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
    summary: 'Batch upsert/delete annotations via POST (alias for PUT /batch)',
  })
  async batchUpsertAnnotationsPost(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: BatchAnnotationsDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.batchUpsertAnnotations(
      userId,
      attachmentId,
      body,
      paramProjectId,
      queryProjectId,
    );
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
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

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
