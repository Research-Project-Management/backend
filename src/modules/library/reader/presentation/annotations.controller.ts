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
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AnnotationType } from '../domain/types/annotations.types';
import { AnnotationsService } from '../application/services/annotations.service';
import { PdfAnnotationImporterService } from '../application/services/pdf-annotation-importer.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  BatchAnnotationsDto,
} from '../application/dtos/annotations.dto';
import { ProjectRoleGuard } from '@/modules/project/access';

// CQRS Use Cases
import { CreateAnnotationUseCase } from '../application/commands/create-annotation.use-case';
import { UpdateAnnotationUseCase } from '../application/commands/update-annotation.use-case';
import { DeleteAnnotationUseCase } from '../application/commands/delete-annotation.use-case';
import { BatchUpsertAnnotationsUseCase } from '../application/commands/batch-upsert-annotations.use-case';
import { ListAnnotationsUseCase } from '../application/queries/list-annotations.use-case';
import { GetAnnotationUseCase } from '../application/queries/get-annotation.use-case';

@ApiTags('Annotations')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/attachments/:attachmentId/annotations',
  'api/v1/projects/:projectId/library/attachments/:attachmentId/annotations',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AnnotationsController {
  private annotationsServiceInstance?: AnnotationsService;
  private pdfAnnotationImporterServiceInstance?: PdfAnnotationImporterService;
  private createAnnotationUseCaseInstance?: CreateAnnotationUseCase;
  private listAnnotationsUseCaseInstance?: ListAnnotationsUseCase;
  private updateAnnotationUseCaseInstance?: UpdateAnnotationUseCase;
  private deleteAnnotationUseCaseInstance?: DeleteAnnotationUseCase;
  private batchUpsertAnnotationsUseCaseInstance?: BatchUpsertAnnotationsUseCase;
  private getAnnotationUseCaseInstance?: GetAnnotationUseCase;

  constructor(
    annotationsService: AnnotationsService,
    pdfAnnotationImporterService: PdfAnnotationImporterService,
  );
  constructor(
    createAnnotationUseCase: CreateAnnotationUseCase,
    listAnnotationsUseCase: ListAnnotationsUseCase,
    updateAnnotationUseCase: UpdateAnnotationUseCase,
    deleteAnnotationUseCase: DeleteAnnotationUseCase,
    batchUpsertAnnotationsUseCase: BatchUpsertAnnotationsUseCase,
    pdfAnnotationImporterService: PdfAnnotationImporterService,
    getAnnotationUseCase?: GetAnnotationUseCase,
    annotationsService?: AnnotationsService,
  );
  constructor(
    @Optional()
    private readonly createAnnotationUseCase?: any,
    @Optional() private readonly listAnnotationsUseCase?: any,
    @Optional()
    private readonly updateAnnotationUseCase?: UpdateAnnotationUseCase,
    @Optional()
    private readonly deleteAnnotationUseCase?: DeleteAnnotationUseCase,
    @Optional()
    private readonly batchUpsertAnnotationsUseCase?: BatchUpsertAnnotationsUseCase,
    @Optional()
    private readonly pdfAnnotationImporterService?: PdfAnnotationImporterService,
    @Optional() private readonly getAnnotationUseCase?: GetAnnotationUseCase,
    @Optional() private readonly annotationsService?: AnnotationsService,
  ) {
    const isLegacyService =
      createAnnotationUseCase &&
      !('execute' in (createAnnotationUseCase as any));

    if (isLegacyService) {
      this.annotationsServiceInstance = createAnnotationUseCase as any;
      this.pdfAnnotationImporterServiceInstance = listAnnotationsUseCase as any;
    } else {
      this.createAnnotationUseCaseInstance = createAnnotationUseCase;
      this.listAnnotationsUseCaseInstance = listAnnotationsUseCase;
      this.updateAnnotationUseCaseInstance = updateAnnotationUseCase;
      this.deleteAnnotationUseCaseInstance = deleteAnnotationUseCase;
      this.batchUpsertAnnotationsUseCaseInstance = batchUpsertAnnotationsUseCase;
      this.pdfAnnotationImporterServiceInstance = pdfAnnotationImporterService;
      this.getAnnotationUseCaseInstance = getAnnotationUseCase;
      this.annotationsServiceInstance = annotationsService;
    }
  }

  private get effectiveAnnotationsService(): AnnotationsService {
    return (this.annotationsServiceInstance ?? this.annotationsService)!;
  }

  private get effectivePdfImporterService(): PdfAnnotationImporterService {
    return (
      this.pdfAnnotationImporterServiceInstance ??
      this.pdfAnnotationImporterService!
    );
  }

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

    if (this.listAnnotationsUseCaseInstance) {
      return this.listAnnotationsUseCaseInstance.execute({
        userId,
        attachmentId,
        pageIndex,
        type,
      });
    }

    return this.effectiveAnnotationsService.getAnnotationsByAttachment(
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

    if (this.createAnnotationUseCaseInstance) {
      return this.createAnnotationUseCaseInstance.execute({
        userId,
        data: createData,
      });
    }

    return this.effectiveAnnotationsService.createAnnotation(userId, createData);
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

    if (this.updateAnnotationUseCaseInstance) {
      return this.updateAnnotationUseCaseInstance.execute({
        userId,
        id,
        expectedVersion: rawVersion,
        data: updateData,
      });
    }

    return this.effectiveAnnotationsService.updateAnnotation(
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

    let deleted: boolean;
    if (this.deleteAnnotationUseCaseInstance) {
      deleted = await this.deleteAnnotationUseCaseInstance.execute({
        userId,
        id,
        expectedVersion,
      });
    } else {
      deleted = await this.effectiveAnnotationsService.deleteAnnotation(
        userId,
        id,
        expectedVersion,
      );
    }

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

    if (this.batchUpsertAnnotationsUseCaseInstance) {
      return this.batchUpsertAnnotationsUseCaseInstance.execute({
        userId,
        attachmentId,
        data: { upserts: body.upserts, deletes: body.deletes },
      });
    }

    return this.effectiveAnnotationsService.batchUpsertAnnotations(
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
    return this.effectivePdfImporterService.importFromAttachment(
      userId,
      attachmentId,
    );
  }
}
