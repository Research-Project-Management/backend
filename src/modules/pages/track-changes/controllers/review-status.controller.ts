/**
 * modules/pages/track-changes/controllers/review-status.controller.ts
 * Domain-focused controller handling project review overview and per-document
 * review status lifecycle endpoints under `/api/v1/pages`.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  HttpStatus,
  HttpCode,
  Optional,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
  CurrentRole,
} from '@/modules/project/access';
import { AuthenticatedRequest, isUuid } from '@/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { UpdateReviewStatusDto } from '../dto/review-status.dto';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import {
  broadcastReviewProjectEvent,
  resolveReviewDocAndProject,
} from '../services/review.helpers';
import {
  getDocReviewStatusWithFallback,
  updateDocReviewStatusWithCas,
  buildProjectReviewOverview,
} from '../services/review-status.helper';

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class ReviewStatusController {
  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly reviewScopeRepo: ReviewScopeRepository,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  @Get([
    'spaces/:spaceId/review-overview',
    'pages/:projectId/review-overview',
    'docs/:projectId/review-overview',
  ])
  @RequireRole(Role.REVIEWER)
  async getProjectReviewOverview(
    @Param('spaceId') routeProjectId: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const resolvedActive =
      this.pageService.resolveActiveProjectId(authorizedProjectId);
    const targetProjectId =
      resolvedActive ||
      (isUuid(routeProjectId)
        ? (await this.pageService.resolveProjectId(routeProjectId)) ||
          routeProjectId
        : routeProjectId);

    if (!targetProjectId || !isUuid(targetProjectId)) {
      return {
        projectId: targetProjectId || routeProjectId,
        files: [],
        totals: {
          openCommentsCount: 0,
          resolvedCommentsCount: 0,
          pendingSuggestionsCount: 0,
          acceptedSuggestionsCount: 0,
          rejectedSuggestionsCount: 0,
          totalVisibleCount: 0,
          totalResolvedCount: 0,
        },
      };
    }

    const reqPageId = (req as { resolvedPageId?: string } | undefined)
      ?.resolvedPageId;
    const explicitPageId =
      reqPageId ??
      (isUuid(routeProjectId) &&
      resolvedActive &&
      routeProjectId !== resolvedActive
        ? routeProjectId
        : undefined);

    return buildProjectReviewOverview({
      reviewScopeRepo: this.reviewScopeRepo,
      projectId: targetProjectId,
      pageId: explicitPageId,
      resolveUserNames: (userIds) =>
        this.userResolver.resolveUserNames(userIds),
    });
  }

  @Get([
    'pages/:pageId/review-status',
    'docs/:pageId/review-status',
    'spaces/:spaceId/docs/:pageId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  async getReviewStatus(
    @Param('pageId') pageId: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    const { docId, projectId } = await resolveReviewDocAndProject({
      pageScopeRepo: this.pageScopeRepo,
      pageService: this.pageService,
      pageId,
      authorizedProjectId: routeProjectId || authorizedProjectId,
      fallbackPrisma: this.reviewScopeRepo.getPrisma?.(),
    });
    if (!docId || !projectId) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const review = await getDocReviewStatusWithFallback(
      this.pageScopeRepo.getPrisma(),
      this.docstoreService,
      projectId,
      docId,
    );

    return { ok: true, docId, projectId, review };
  }

  @Post([
    'pages/:pageId/review-status',
    'docs/:pageId/review-status',
    'spaces/:spaceId/docs/:pageId/review-status',
  ])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async updateReviewStatus(
    @Param('pageId') pageId: string,
    @Body() body: UpdateReviewStatusDto,
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @CurrentRole() currentRole: Role,
    @Param('spaceId') routeProjectId?: string,
    @CurrentUser('id') userId?: string,
  ) {
    const { docId, projectId } = await resolveReviewDocAndProject({
      pageScopeRepo: this.pageScopeRepo,
      pageService: this.pageService,
      pageId,
      authorizedProjectId: routeProjectId || authorizedProjectId,
      fallbackPrisma: this.reviewScopeRepo.getPrisma?.(),
    });
    if (!docId || !projectId) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const doc = await this.pageScopeRepo.findDocInProject(projectId, docId);
    if (!doc) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const { review: updatedReview, previousStatus } =
      await updateDocReviewStatusWithCas({
        prisma: this.pageScopeRepo.getPrisma(),
        docstoreService: this.docstoreService,
        projectId,
        docId,
        body,
        currentRole,
        userId,
      });

    broadcastReviewProjectEvent(
      this.eventEmitter,
      projectId,
      'review:status-changed',
      {
        docId,
        projectId,
        review: updatedReview,
        previousStatus,
        updatedById: userId,
      },
    );

    return { ok: true, docId, projectId, review: updatedReview };
  }
}
