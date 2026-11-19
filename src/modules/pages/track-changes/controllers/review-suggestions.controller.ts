/**
 * modules/pages/track-changes/controllers/review-suggestions.controller.ts
 * Domain-focused controller handling track-change suggestion CRUD and resolution routes
 * under `/api/v1/pages`.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import {
  ReviewSuggestionsService,
  type CreateSuggestionBody,
} from '../services/review-suggestions.service';

export type { CreateSuggestionBody };

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class ReviewSuggestionsController {
  constructor(
    private readonly reviewSuggestionsService: ReviewSuggestionsService,
  ) {}

  @Get([
    'pages/:pageId/suggestions',
    'docs/:pageId/suggestions',
    'spaces/:spaceId/docs/:pageId/suggestions',
  ])
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.reviewSuggestionsService.getSuggestions(
      pageId,
      status,
      routeProjectId,
      authorizedProjectId,
    );
  }

  @Post([
    'pages/:pageId/suggestions',
    'docs/:pageId/suggestions',
    'spaces/:spaceId/docs/:pageId/suggestions',
  ])
  @HttpCode(HttpStatus.CREATED)
  async createSuggestion(
    @Param('pageId') pageId: string,
    @Body() body: CreateSuggestionBody,
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.reviewSuggestionsService.createSuggestion(
      pageId,
      body,
      req,
      routeProjectId,
      authorizedProjectId,
    );
  }

  @Post([
    'pages/:pageId/suggestions/:suggestionId/accept',
    'docs/:pageId/suggestions/:suggestionId/accept',
    'spaces/:spaceId/docs/:pageId/suggestions/:suggestionId/accept',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.reviewSuggestionsService.acceptSuggestion(
      pageId,
      suggestionId,
      routeProjectId,
      authorizedProjectId,
      userId,
    );
  }

  @Post([
    'pages/:pageId/suggestions/:suggestionId/reject',
    'docs/:pageId/suggestions/:suggestionId/reject',
    'spaces/:spaceId/docs/:pageId/suggestions/:suggestionId/reject',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @Param('spaceId') routeProjectId?: string,
    @ResolvedSpace() authorizedProjectId?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.reviewSuggestionsService.rejectSuggestion(
      pageId,
      suggestionId,
      routeProjectId,
      authorizedProjectId,
      userId,
    );
  }

  @Post([
    'pages/:pageId/suggestions/accept-all',
    'docs/:pageId/suggestions/accept-all',
    'spaces/:spaceId/docs/:pageId/suggestions/accept-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount =
      await this.reviewSuggestionsService.batchResolvePageSuggestions(
        pageId,
        routeProjectId || authorizedProjectId,
        true,
        body?.suggestionIds,
        req?.user?.id || req?.user?.sub || null,
      );
    return { ok: true, acceptedCount: resolvedCount, resolvedCount };
  }

  @Post([
    'pages/:pageId/suggestions/reject-all',
    'docs/:pageId/suggestions/reject-all',
    'spaces/:spaceId/docs/:pageId/suggestions/reject-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectAllSuggestions(
    @Param('pageId') pageId: string,
    @Body() body: { suggestionIds?: string[] },
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount =
      await this.reviewSuggestionsService.batchResolvePageSuggestions(
        pageId,
        routeProjectId || authorizedProjectId,
        false,
        body?.suggestionIds,
        req?.user?.id || req?.user?.sub || null,
      );
    return { ok: true, rejectedCount: resolvedCount, resolvedCount };
  }

  @Post([
    'pages/:pageId/suggestions/batch-resolve',
    'docs/:pageId/suggestions/batch-resolve',
    'spaces/:spaceId/docs/:pageId/suggestions/batch-resolve',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async batchResolveSuggestions(
    @Param('pageId') pageId: string,
    @Body()
    body: {
      action: 'accept' | 'reject' | 'accept_all' | 'reject_all';
      suggestionIds?: string[];
    },
    @ResolvedSpace() authorizedProjectId: string | { id: string } | null,
    @Param('spaceId') routeProjectId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const isAccept = body?.action === 'accept' || body?.action === 'accept_all';
    const resolvedCount =
      await this.reviewSuggestionsService.batchResolvePageSuggestions(
        pageId,
        routeProjectId || authorizedProjectId,
        isAccept,
        body?.suggestionIds,
        req?.user?.id || req?.user?.sub || null,
      );
    return {
      ok: true,
      action: isAccept ? 'accept' : 'reject',
      resolvedCount,
      acceptedCount: isAccept ? resolvedCount : 0,
      rejectedCount: isAccept ? 0 : resolvedCount,
    };
  }
}
