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

  @Get(['spaces/:spaceId/review-overview', 'pages/:pageId/review-overview'])
  async getOverview(
    @Param('spaceId') spaceId?: string,
    @Param('pageId') pageId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    const reqPageId = (req as { resolvedPageId?: string } | undefined)
      ?.resolvedPageId;
    return this.statusService.getOverview(
      pageId || spaceId || '',
      reqPageId,
      authSpace,
    );
  }

  @Get('docs/:docId/review-status')
  async getStatus(
    @Param('docId') docId: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.statusService.getStatus(docId, undefined, authSpace);
  }

  @Post('docs/:docId/review-status')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param('docId') docId: string,
    @Body() body: UpdateReviewStatusDto,
    @ResolvedSpace() authSpace: string | { id: string } | null,
    @CurrentRole() currentRole: Role,
    @CurrentUser('id') userId?: string,
  ) {
    return this.statusService.updateStatus(
      docId,
      body,
      authSpace,
      currentRole,
      undefined,
      userId,
    );
  }
}
