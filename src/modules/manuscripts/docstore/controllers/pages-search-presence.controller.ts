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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectRoleGuard, RequireRole, Role } from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import type { FastifyReply } from 'fastify';
import {
  ManuscriptPresenceService,
  HeartbeatBody,
} from '../services/manuscript-presence.service';
import { ManuscriptSearchReplaceService } from '../services/manuscript-search-replace.service';

@ApiTags('Manuscripts - Pages Search & Presence')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/manuscripts', 'v1/manuscripts', 'manuscripts', 'api'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
@RequireRole(Role.REVIEWER)
export class PagesSearchPresenceController {
  constructor(
    private readonly presenceService: ManuscriptPresenceService,
    private readonly searchReplaceService: ManuscriptSearchReplaceService,
  ) {}

  // ─── 1. REAL-TIME COLLABORATION HTTP FALLBACKS & SSE STREAM ──────────────────

  /**
   * GET /api/v1/manuscripts/docs/:pageId/collaboration/presence
   * GET /api/pages/:pageId/collaboration/presence
   * GET /api/v1/manuscripts/docs/:pageId/presence
   * GET /api/pages/:pageId/presence
   */
  @Get([
    'docs/:pageId/collaboration/presence',
    'pages/:pageId/collaboration/presence',
    'docs/:pageId/presence',
    'pages/:pageId/presence',
  ])
  async getPresence(@Param('pageId') pageId: string) {
    const { users, realtimeAvailable } =
      await this.presenceService.collectPresence(pageId);
    return { activeUsers: users, presence: users, realtimeAvailable };
  }

  /**
   * POST /api/v1/manuscripts/docs/:pageId/collaboration/heartbeat
   * POST /api/pages/:pageId/collaboration/heartbeat
   * POST /api/v1/manuscripts/docs/:pageId/presence/heartbeat
   * POST /api/pages/:pageId/presence/heartbeat
   */
  @Post([
    'docs/:pageId/collaboration/heartbeat',
    'pages/:pageId/collaboration/heartbeat',
    'docs/:pageId/presence/heartbeat',
    'pages/:pageId/presence/heartbeat',
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
   * POST /api/pages/:pageId/collaboration/leave
   * POST /api/v1/manuscripts/docs/:pageId/presence/leave
   * POST /api/pages/:pageId/presence/leave
   */
  @Post([
    'docs/:pageId/collaboration/leave',
    'pages/:pageId/collaboration/leave',
    'docs/:pageId/presence/leave',
    'pages/:pageId/presence/leave',
  ])
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
   * GET /api/pages/:pageId/collaboration/stream
   * GET /api/projects/:projectId/pages/:pageId/collaboration/stream
   * GET /api/v1/manuscripts/docs/:pageId/stream
   * GET /api/pages/:pageId/stream
   */
  @Get([
    'docs/:pageId/collaboration/stream',
    'projects/:projectId/docs/:pageId/collaboration/stream',
    'pages/:pageId/collaboration/stream',
    'projects/:projectId/pages/:pageId/collaboration/stream',
    'docs/:pageId/stream',
    'pages/:pageId/stream',
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
      'http://localhost:2915';
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
   * POST /api/projects/:projectId/documents/search
   * POST /api/v1/manuscripts/docs/search
   * POST /api/pages/search
   */
  @Post([
    'projects/:projectId/search',
    'projects/:projectId/documents/search',
    'docs/search',
    'pages/search',
  ])
  @HttpCode(HttpStatus.OK)
  async searchDocuments(
    @Param('projectId') projectId: string,
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
  ) {
    const targetProjectId = projectId || body?.projectId || '';
    return this.searchReplaceService.searchDocuments(targetProjectId, body);
  }

  /**
   * POST /api/v1/manuscripts/projects/:projectId/replace
   * POST /api/projects/:projectId/documents/replace
   * POST /api/v1/manuscripts/docs/replace
   * POST /api/pages/replace
   */
  @Post([
    'projects/:projectId/replace',
    'projects/:projectId/documents/replace',
    'docs/replace',
    'pages/replace',
  ])
  @HttpCode(HttpStatus.OK)
  async replaceDocuments(
    @Param('projectId') projectId: string,
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
  ) {
    const targetProjectId = projectId || body?.projectId || '';
    return this.searchReplaceService.replaceDocuments(targetProjectId, body);
  }
}
