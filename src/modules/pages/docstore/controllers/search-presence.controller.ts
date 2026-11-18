/**
 * modules/manuscripts/docstore/controllers/search-presence.controller.ts
 * Domain-focused controller handling Project/Document Search & Replace
 * and Real-Time Collaboration Presence / Heartbeat / SSE Stream routes.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Res,
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
import type { FastifyReply } from 'fastify';
import { PresenceService, HeartbeatBody } from '../services/presence.service';
import { SearchReplaceService } from '../services/search-replace.service';

@ApiTags('Manuscripts - Pages Search & Presence')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class SearchPresenceController {
  constructor(
    private readonly presenceService: PresenceService,
    private readonly searchReplaceService: SearchReplaceService,
  ) {}

  private resolveSpaceId(
    space?: string | { id: string; spaceId?: string } | null,
    routeSpaceId?: string,
  ): string | undefined {
    if (!space) return routeSpaceId || undefined;
    if (typeof space === 'string') return space;
    return space.spaceId ?? space.id ?? routeSpaceId ?? undefined;
  }

  // ─── 1. REAL-TIME COLLABORATION HTTP FALLBACKS & SSE STREAM ──────────────────

  /**
   * GET /api/v1/pages/docs/:pageId/collaboration/presence
   * GET /api/v1/pages/docs/:pageId/presence
   */
  @Get(['docs/:pageId/collaboration/presence', 'docs/:pageId/presence'])
  async getPresence(
    @Param('pageId') pageId: string,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const resolvedSpaceId = this.resolveSpaceId(space);
    const { users, realtimeAvailable } =
      await this.presenceService.collectPresence(pageId, resolvedSpaceId);
    return { activeUsers: users, presence: users, realtimeAvailable };
  }

  /**
   * POST /api/v1/pages/docs/:pageId/collaboration/heartbeat
   * POST /api/v1/pages/docs/:pageId/presence/heartbeat
   */
  @Post([
    'docs/:pageId/collaboration/heartbeat',
    'docs/:pageId/presence/heartbeat',
  ])
  @HttpCode(HttpStatus.OK)
  async sendHeartbeat(
    @Param('pageId') pageId: string,
    @Body() body: HeartbeatBody,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    const userName =
      req?.user?.name || req?.user?.email || body?.name || 'Collaborator';
    const resolvedSpaceId = this.resolveSpaceId(space);
    return this.presenceService.recordHeartbeat(
      pageId,
      userId,
      userName,
      body,
      resolvedSpaceId,
    );
  }

  /**
   * POST /api/v1/pages/docs/:pageId/collaboration/leave
   * POST /api/v1/pages/docs/:pageId/presence/leave
   */
  @Post(['docs/:pageId/collaboration/leave', 'docs/:pageId/presence/leave'])
  @HttpCode(HttpStatus.OK)
  async leaveRoom(
    @Param('pageId') pageId: string,
    @Req() req: AuthenticatedRequest,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    const resolvedSpaceId = this.resolveSpaceId(space);
    return this.presenceService.leaveRoom(pageId, userId, resolvedSpaceId);
  }

  /**
   * Server-Sent Events stream for clients without a WebSocket connection.
   * Emits `presence` events when the merged collaborator set changes and
   * `content-updated` events when the persisted doc version advances.
   *
   * GET /api/v1/pages/docs/:pageId/collaboration/stream
   * GET /api/v1/pages/spaces/:spaceId/docs/:pageId/collaboration/stream
   * GET /api/v1/pages/docs/:pageId/stream
   */
  @Get([
    'docs/:pageId/collaboration/stream',
    'spaces/:spaceId/docs/:pageId/collaboration/stream',
    'docs/:pageId/stream',
  ])
  async getStream(
    @Param('pageId') pageId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Param('spaceId') routeSpaceId?: string,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const origin =
      (Array.isArray(req.headers?.origin)
        ? req.headers.origin[0]
        : req.headers?.origin) ||
      (Array.isArray(req.headers?.Origin)
        ? req.headers.Origin[0]
        : req.headers?.Origin) ||
      undefined;
    const resolvedSpaceId = this.resolveSpaceId(space, routeSpaceId);
    await this.presenceService.streamPresenceAndUpdates(
      pageId,
      origin,
      req.raw,
      reply,
      resolvedSpaceId,
    );
  }

  // ─── 2. PROJECT DOCUMENT SEARCH & REPLACE ────────────────────────────────────

  /**
   * POST /api/v1/pages/spaces/:spaceId/search
   * POST /api/v1/pages/pages/:pageId/search
   * POST /api/v1/pages/docs/search
   */
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

  /**
   * POST /api/v1/pages/spaces/:spaceId/replace
   * POST /api/v1/pages/pages/:pageId/replace
   * POST /api/v1/pages/docs/replace
   */
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

/** @deprecated Use SearchPresenceController */
export { SearchPresenceController as PagesSearchPresenceController };
