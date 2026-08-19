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
import { AnnotationService } from './annotation.service';
import { CreateAnnotationDto, UpdateAnnotationDto } from './dto/annotation.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library - PDF Annotations & Notes')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/annotations')
@UseGuards(JwtAuthGuard)
export class AnnotationController {
  constructor(private readonly annotationService: AnnotationService) {}

  @Get(':workspaceId/:paperId')
  @ApiOperation({ summary: 'Get all PDF annotations for a paper' })
  async getAnnotations(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
  ) {
    return this.annotationService.getAnnotations(workspaceId, paperId);
  }

  @Post(':workspaceId/:paperId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new PDF annotation (highlight, underline, note, box)' })
  async createAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateAnnotationDto,
  ) {
    return this.annotationService.createAnnotation(workspaceId, paperId, userId, dto);
  }

  @Put(':workspaceId/:paperId/:annotationId')
  @ApiOperation({ summary: 'Update an existing annotation comment or color' })
  async updateAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @Param('annotationId') annotationId: string,
    @Body() dto: UpdateAnnotationDto,
  ) {
    return this.annotationService.updateAnnotation(workspaceId, paperId, annotationId, dto);
  }

  @Delete(':workspaceId/:paperId/:annotationId')
  @ApiOperation({ summary: 'Delete a PDF annotation' })
  async deleteAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @Param('annotationId') annotationId: string,
  ) {
    return this.annotationService.deleteAnnotation(workspaceId, paperId, annotationId);
  }

  @Post(':workspaceId/:paperId/extract-notes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Zotero 7 Parity: Extract all PDF annotations into a synthesized Markdown Literature Note',
  })
  async extractNotes(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.annotationService.extractNotesFromAnnotations(workspaceId, paperId, userId);
  }
}
