/**
 * modules/manuscripts/docstore/controllers/pages-search-presence.controller.ts
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
  ResolvedProject,
} from '@/modules/project/access';
import {
  AuthenticatedRequest,
  UserRateLimit,
  UserRateLimitGuard,
} from '@/core';
import type { FastifyReply } from 'fastify';
import {
  ManuscriptPresenceService,
  HeartbeatBody,
} from '../services/manuscript-presence.service';
import { ManuscriptSearchReplaceService } from '../services/manuscript-search-replace.service';

@ApiTags('Manuscripts - Pages Search & Presence')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PagesSearchPresenceController {
  constructor(
    private readonly presenceService: ManuscriptPresenceService,
    private readonly searchReplaceService: ManuscriptSearchReplaceService,
  ) {}

  // ─── 1. REAL-TIME COLLABORATION HTTP FALLBACKS & SSE STREAM ──────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/collaboration/presence
   * GET /api/v1/manuscripts/docs/:pageId/presence
   */
  @Get(['docs/:pageId/collaboration/presence', 'docs/:pageId/presence'])
  async getPresence(@Param('pageId') pageId: string) {
    const { users, realtimeAvailable } =
      await this.presenceService.collectPresence(pageId);
    return { activeUsers: users, presence: users, realtimeAvailable };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/collaboration/heartbeat
   * POST /api/v1/manuscripts/docs/:pageId/presence/heartbeat
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
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    const userName =
      req?.user?.name || req?.user?.email || body?.name || 'Collaborator';
    return this.presenceService.recordHeartbeat(pageId, userId, userName, body);
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/collaboration/leave
   * POST /api/v1/manuscripts/docs/:pageId/presence/leave
   */
  @Post(['docs/:pageId/collaboration/leave', 'docs/:pageId/presence/leave'])
  @HttpCode(HttpStatus.OK)
  async leaveRoom(
    @Param('pageId') pageId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    return this.presenceService.leaveRoom(pageId, userId);
  }

  /**
   * Server-Sent Events stream for clients without a WebSocket connection.
   * Emits `presence` events when the merged collaborator set changes and
   * `content-updated` events when the persisted doc version advances.
   *
   * GET /api/v1/manuscripts/docs/:pageId/collaboration/stream
   * GET /api/v1/manuscripts/projects/:projectId/docs/:pageId/collaboration/stream
   * GET /api/v1/manuscripts/docs/:pageId/stream
   */
  @Get([
    'docs/:pageId/collaboration/stream',
    'projects/:projectId/docs/:pageId/collaboration/stream',
    'docs/:pageId/stream',
  ])
  async getStream(
    @Param('pageId') pageId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const origin =
      (Array.isArray(req.headers?.origin)
        ? req.headers.origin[0]
        : req.headers?.origin) ||
      (Array.isArray(req.headers?.Origin)
        ? req.headers.Origin[0]
        : req.headers?.Origin) ||
      undefined;
    await this.presenceService.streamPresenceAndUpdates(
      pageId,
      origin,
      req.raw,
      reply,
    );
  }

  // ─── 2. PROJECT DOCUMENT SEARCH & REPLACE ────────────────────────────────────

  /**
   * POST /api/v1/manuscripts/projects/:projectId/search
   * POST /api/v1/manuscripts/docs/search
   */
  @Post(['projects/:projectId/search', 'docs/search'])
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  async searchDocuments(
    @Param('projectId') routeProjectId: string | undefined,
    @Body()
    body: {
      projectId?: string;
      query: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
      fileIds?: string[];
      maxResults?: number;
    },
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    const resolvedProjectId =
      typeof project === 'string' ? project : project?.id;
    const targetProjectId =
      resolvedProjectId || routeProjectId || body?.projectId || '';
    if (!targetProjectId) {
      throw new BadRequestException('Project context required');
    }
    return this.searchReplaceService.searchDocuments(targetProjectId, body);
  }

  /**
   * POST /api/v1/manuscripts/projects/:projectId/replace
   * POST /api/v1/manuscripts/docs/replace
   */
  @Post(['projects/:projectId/replace', 'docs/replace'])
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('search-replace')
  @HttpCode(HttpStatus.OK)
  async replaceDocuments(
    @Param('projectId') routeProjectId: string | undefined,
    @Body()
    body: {
      projectId?: string;
      query: string;
      replaceWith: string;
      fileIds?: string[];
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
    },
    @ResolvedProject() project?: string | { id: string } | null,
  ) {
    const resolvedProjectId =
      typeof project === 'string' ? project : project?.id;
    const targetProjectId =
      resolvedProjectId || routeProjectId || body?.projectId || '';
    if (!targetProjectId) {
      throw new BadRequestException('Project context required');
    }
    return this.searchReplaceService.replaceDocuments(targetProjectId, body);
  }
}
