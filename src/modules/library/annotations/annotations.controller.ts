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
  UnauthorizedException,
} from '@nestjs/common';
import { AnnotationsService } from './annotations.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
} from './dto/annotations.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/attachments/:attachmentId/annotations',
  'api/v1/workspace/:workspaceId/library/attachments/:attachmentId/annotations',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class AnnotationsController {
  constructor(private readonly annotationsService: AnnotationsService) {}

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async listAnnotations(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('pageIndex') pageIndex?: string,
  ) {
    let parsedPage: number | undefined;
    if (pageIndex !== undefined) {
      parsedPage = parseInt(pageIndex, 10);
      if (isNaN(parsedPage) || parsedPage < 0) {
        throw new BadRequestException(
          'pageIndex must be a non-negative integer',
        );
      }
    }
    return this.annotationsService.getAnnotationsByAttachment(
      workspaceId,
      attachmentId,
      parsedPage,
    );
  }

  @Post()
  @WorkspaceRoles('owner', 'admin', 'member')
  async createAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateAnnotationDto,
  ) {
    if (!currentUserId) {
      throw new UnauthorizedException(
        'Authentication required to create annotations',
      );
    }
    return this.annotationsService.createAnnotation(workspaceId, {
      attachmentId,
      type: body.type,
      pageIndex: body.pageIndex,
      color: body.color,
      quoteText: body.quoteText,
      comment: body.comment,
      rectCoords: body.rectCoords,
      authorId: currentUserId,
    });
  }

  @Patch(':id')
  @WorkspaceRoles('owner', 'admin', 'member')
  async updateAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateAnnotationDto,
  ) {
    const rawVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/["']/g, ''), 10) : undefined);
    if (rawVersion === undefined || isNaN(rawVersion) || rawVersion < 1) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion (>= 1) or If-Match header is required',
      );
    }

    const { expectedVersion: _, ...updateData } = body;
    return this.annotationsService.updateAnnotation(
      workspaceId,
      id,
      rawVersion,
      updateData,
      currentUserId,
    );
  }

  @Delete(':id')
  @WorkspaceRoles('owner', 'admin', 'member')
  async deleteAnnotation(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser('id') currentUserId: string,
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
      expectedVersion = parseInt(ifMatch.replace(/["']/g, ''), 10);
      if (isNaN(expectedVersion) || expectedVersion < 1) {
        throw new BadRequestException(
          'If-Match header must be a positive integer',
        );
      }
    }

    const deleted = await this.annotationsService.deleteAnnotation(
      workspaceId,
      id,
      expectedVersion,
      currentUserId,
    );
    if (!deleted) {
      throw new NotFoundException(`Annotation ${id} not found`);
    }

    return { deleted, id };
  }
}
