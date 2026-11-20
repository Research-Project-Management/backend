/**
 * modules/pages/docstore/controllers/presence.controller.ts
 * Domain-focused controller handling real-time collaboration presence,
 * heartbeats, and room leaves (primary realtime transport is Socket.IO /pages).
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
}
