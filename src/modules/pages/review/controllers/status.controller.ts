import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedRequest } from '@/core';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  CurrentRole,
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { UpdateReviewStatusDto } from '../dto/status.dto';
import { ReviewStatusService } from '../services/status.service';

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class ReviewStatusController {
  constructor(private readonly statusService: ReviewStatusService) {}

  @Get([
    'spaces/:spaceId/review-overview',
    'pages/:pageId/review-overview',
    'docs/:docId/review-overview',
  ])
  @RequireRole(Role.REVIEWER)
  async getOverview(
    @Param('spaceId') spaceId?: string,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    const reqPageId = (req as { resolvedPageId?: string } | undefined)
      ?.resolvedPageId;
    return this.statusService.getOverview(
      docId || pageId || spaceId || '',
      reqPageId,
      authSpace,
    );
  }

  @Get([
    'pages/:pageId/review-status',
    'docs/:docId/review-status',
    'spaces/:spaceId/docs/:docId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  async getStatus(
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.statusService.getStatus(
      docId || pageId || '',
      spaceId,
      authSpace,
    );
  }

  @Post([
    'pages/:pageId/review-status',
    'docs/:docId/review-status',
    'spaces/:spaceId/docs/:docId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Body() body: UpdateReviewStatusDto,
    @ResolvedSpace() authSpace: string | { id: string } | null,
    @CurrentRole() currentRole: Role,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @CurrentUser('id') userId?: string,
  ) {
    return this.statusService.updateStatus(
      docId || pageId || '',
      body,
      authSpace,
      currentRole,
      spaceId,
      userId,
    );
  }
}
