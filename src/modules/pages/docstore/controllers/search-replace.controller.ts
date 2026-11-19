/**
 * modules/pages/docstore/controllers/search-replace.controller.ts
 * Domain-focused controller handling project-wide full-text/regex search
 * and batch document replacement routes.
 */

import {
  Controller,
  Post,
  Param,
  Body,
  Req,
  HttpStatus,
  HttpCode,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import {
  AuthenticatedRequest,
  UserRateLimit,
  UserRateLimitGuard,
} from '@/core';
import { SearchReplaceService } from '../services/search-replace.service';

@ApiTags('Manuscripts - Pages Search & Presence')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class SearchReplaceController {
  constructor(private readonly searchReplaceService: SearchReplaceService) {}

  @Post(['spaces/:spaceId/search', 'pages/:pageId/search', 'docs/search'])
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  async searchDocuments(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Param('pageId') routePageId: string | undefined,
    @Body()
    body: {
      spaceId?: string;
      pageId?: string;
      query: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
      fileIds?: string[];
      maxResults?: number;
    },
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    const resolvedSpaceId = typeof space === 'string' ? space : space?.id;
    const targetSpaceId =
      resolvedSpaceId || routeSpaceId || routePageId || body?.spaceId || '';
    if (!targetSpaceId) {
      throw new BadRequestException('Space context required');
    }
    const resolvedPageId =
      routePageId ||
      (req as { resolvedPageId?: string } | undefined)?.resolvedPageId ||
      body?.pageId;
    return this.searchReplaceService.searchDocuments(targetSpaceId, {
      ...body,
      ...(resolvedPageId ? { pageId: resolvedPageId } : {}),
    });
  }

  @Post(['spaces/:spaceId/replace', 'pages/:pageId/replace', 'docs/replace'])
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  async replaceDocuments(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Param('pageId') routePageId: string | undefined,
    @Body()
    body: {
      spaceId?: string;
      pageId?: string;
      query: string;
      replaceWith: string;
      fileIds?: string[];
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
    },
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace() space?: string | { id: string } | null,
  ) {
    const resolvedSpaceId = typeof space === 'string' ? space : space?.id;
    const targetSpaceId =
      resolvedSpaceId || routeSpaceId || routePageId || body?.spaceId || '';
    if (!targetSpaceId) {
      throw new BadRequestException('Space context required');
    }
    const resolvedPageId =
      routePageId ||
      (req as { resolvedPageId?: string } | undefined)?.resolvedPageId ||
      body?.pageId;
    return this.searchReplaceService.replaceDocuments(targetSpaceId, {
      ...body,
      ...(resolvedPageId ? { pageId: resolvedPageId } : {}),
    });
  }
}
