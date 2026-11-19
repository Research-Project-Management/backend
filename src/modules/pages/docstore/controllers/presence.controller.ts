/**
 * modules/pages/docstore/controllers/presence.controller.ts
 * Domain-focused controller handling real-time collaboration presence,
 * heartbeats, room leaves, and SSE stream fallbacks.
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
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedSpace,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import type { FastifyReply } from 'fastify';
import { PresenceService, HeartbeatBody } from '../services/presence.service';

@ApiTags('Manuscripts - Pages Search & Presence')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  private resolveSpaceId(
    space?: string | { id: string; spaceId?: string } | null,
    routeSpaceId?: string,
  ): string | undefined {
    if (!space) return routeSpaceId || undefined;
    if (typeof space === 'string') return space;
    return space.spaceId ?? space.id ?? routeSpaceId ?? undefined;
  }

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
}
