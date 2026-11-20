import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedRequest } from '@/core';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import {
  BatchResolveDto,
  CreateSuggestionDto,
  SuggestionIdsDto,
} from '../dto/review.dto';
import { SuggestionsService } from '../services/suggestions.service';

@ApiTags('Manuscripts - Pages Review & Comments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class SuggestionsController {
  constructor(private readonly suggestionsService: SuggestionsService) {}

  @Get([
    'pages/:pageId/suggestions',
    'docs/:docId/suggestions',
    'spaces/:spaceId/docs/:docId/suggestions',
  ])
  async list(
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Query('status') status?: 'pending' | 'accepted' | 'rejected',
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.suggestionsService.list(
      docId || pageId || '',
      status,
      spaceId,
      authSpace,
    );
  }

  @Post([
    'pages/:pageId/suggestions',
    'docs/:docId/suggestions',
    'spaces/:spaceId/docs/:docId/suggestions',
  ])
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateSuggestionDto,
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
  ) {
    return this.suggestionsService.create(
      docId || pageId || '',
      body,
      req,
      spaceId,
      authSpace,
    );
  }

  @Post([
    'pages/:pageId/suggestions/:suggestionId/accept',
    'docs/:docId/suggestions/:suggestionId/accept',
    'spaces/:spaceId/docs/:docId/suggestions/:suggestionId/accept',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('suggestionId') suggestionId: string,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.suggestionsService.accept(
      docId || pageId || '',
      suggestionId,
      spaceId,
      authSpace,
      userId,
    );
  }

  @Post([
    'pages/:pageId/suggestions/:suggestionId/reject',
    'docs/:docId/suggestions/:suggestionId/reject',
    'spaces/:spaceId/docs/:docId/suggestions/:suggestionId/reject',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('suggestionId') suggestionId: string,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @ResolvedSpace() authSpace?: string | { id: string } | null,
    @CurrentUser('id') userId?: string,
  ) {
    return this.suggestionsService.reject(
      docId || pageId || '',
      suggestionId,
      spaceId,
      authSpace,
      userId,
    );
  }

  @Post([
    'pages/:pageId/suggestions/accept-all',
    'docs/:docId/suggestions/accept-all',
    'spaces/:spaceId/docs/:docId/suggestions/accept-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async acceptAll(
    @Body() body: SuggestionIdsDto,
    @ResolvedSpace() authSpace: string | { id: string } | null,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount = await this.suggestionsService.batchResolve(
      docId || pageId || '',
      spaceId || authSpace,
      true,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return { ok: true, acceptedCount: resolvedCount, resolvedCount };
  }

  @Post([
    'pages/:pageId/suggestions/reject-all',
    'docs/:docId/suggestions/reject-all',
    'spaces/:spaceId/docs/:docId/suggestions/reject-all',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async rejectAll(
    @Body() body: SuggestionIdsDto,
    @ResolvedSpace() authSpace: string | { id: string } | null,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const resolvedCount = await this.suggestionsService.batchResolve(
      docId || pageId || '',
      spaceId || authSpace,
      false,
      body?.suggestionIds,
      req?.user?.id || req?.user?.sub || null,
    );
    return { ok: true, rejectedCount: resolvedCount, resolvedCount };
  }

  @Post([
    'pages/:pageId/suggestions/batch-resolve',
    'docs/:docId/suggestions/batch-resolve',
    'spaces/:spaceId/docs/:docId/suggestions/batch-resolve',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  async batchResolve(
    @Body() body: BatchResolveDto,
    @ResolvedSpace() authSpace: string | { id: string } | null,
    @Param('pageId') pageId?: string,
    @Param('docId') docId?: string,
    @Param('spaceId') spaceId?: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    const isAccept = body?.action === 'accept' || body?.action === 'accept_all';
    const resolvedCount = await this.suggestionsService.batchResolve(
      docId || pageId || '',
      spaceId || authSpace,
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
