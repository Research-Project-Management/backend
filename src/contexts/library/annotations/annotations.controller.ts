import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AnnotationsService } from './annotations.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { AnnotationType } from '@prisma/client';

export class CreateAnnotationDto {
  type?: AnnotationType;
  pageIndex!: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: any;
}

export class UpdateAnnotationDto {
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: any;
  expectedVersion?: number;
}

@Controller(
  'api/v1/workspaces/:workspaceId/library/attachments/:attachmentId/annotations',
)
@UseGuards(JwtAuthGuard)
export class AnnotationsController {
  constructor(private readonly annotationsService: AnnotationsService) {}

  @Get()
  async listAnnotations(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('pageIndex') pageIndex?: string,
  ) {
    const parsedPage =
      pageIndex !== undefined ? parseInt(pageIndex, 10) : undefined;
    const annotations =
      await this.annotationsService.getAnnotationsByAttachment(
        workspaceId,
        attachmentId,
        parsedPage,
      );

    return {
      success: true,
      data: annotations,
    };
  }

  @Post()
  async createAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateAnnotationDto,
  ) {
    const annotation = await this.annotationsService.createAnnotation(
      workspaceId,
      {
        attachmentId,
        type: body.type,
        pageIndex: body.pageIndex,
        color: body.color,
        quoteText: body.quoteText,
        comment: body.comment,
        rectCoords: body.rectCoords,
        authorId: currentUserId || 'system',
      },
    );

    return {
      success: true,
      data: annotation,
    };
  }

  @Patch(':id')
  async updateAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateAnnotationDto,
  ) {
    const expectedVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/["']/g, ''), 10) : undefined);
    if (!expectedVersion || isNaN(expectedVersion)) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }

    const { expectedVersion: _, ...updateData } = body;
    const updated = await this.annotationsService.updateAnnotation(
      workspaceId,
      id,
      expectedVersion,
      updateData,
    );

    return {
      success: true,
      data: updated,
    };
  }

  @Delete(':id')
  async deleteAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const deleted = await this.annotationsService.deleteAnnotation(
      workspaceId,
      id,
      expectedVersion,
    );
    if (!deleted) {
      throw new NotFoundException(`Annotation ${id} not found`);
    }

    return {
      success: true,
      data: { deleted },
    };
  }
}
