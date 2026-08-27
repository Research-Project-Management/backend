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
import { AnnotationsService } from './annotations.service';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
} from './dto/annotations.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Annotations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@Controller('workspace/:workspaceId/library/items/:itemId/annotations')
export class AnnotationsController {
  constructor(private readonly annotationsService: AnnotationsService) {}

  @Get()
  @WorkspaceRoles('admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all PDF annotations for a catalog item' })
  async getAnnotations(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.annotationsService.getAnnotations(workspaceId, itemId);
  }

  @Post()
  @WorkspaceRoles('admin', 'member')
  @ApiOperation({ summary: 'Add a new PDF annotation (highlight/note/rect)' })
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

  @Put(':annotationId')
  @WorkspaceRoles('admin', 'member')
  @ApiOperation({ summary: 'Update an annotation comment or color' })
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

  @Delete(':annotationId')
  @WorkspaceRoles('admin', 'member')
  @HttpCode(HttpStatus.OK)
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

  @Post('extract-notes')
  @WorkspaceRoles('admin', 'member')
  @ApiOperation({
    summary: 'Extract and compile literature notes from annotations',
  })
  async extractNotes(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.annotationsService.extractLiteratureNotes(
      workspaceId,
      itemId,
      userId,
    );
  }
}
