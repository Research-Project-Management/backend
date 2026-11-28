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
  Query,
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
import { resolvePageControllerCoordinates } from '@/modules/pages/core';
import { PresenceService, HeartbeatBody } from '../services/presence.service';

@ApiTags('Pages - Search & Presence')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  private resolveCoordinates(
    params: { spaceId?: string; pageId?: string },
    space?: string | { id: string; spaceId?: string } | null,
    queryPageId?: string,
    req?: AuthenticatedRequest,
  ): { spaceId?: string; targetId: string } {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      params,
      space,
      queryPageId,
      req,
    );
    return {
      spaceId: spaceId || undefined,
      targetId: pageId || params.pageId || spaceId,
    };
  }

  @Get([
    'docs/:pageId/collaboration/presence',
    'docs/:pageId/presence',
    'spaces/:spaceId/collaboration/presence',
    'spaces/:spaceId/presence',
  ])
  async getPresence(
    @Param('pageId') pageId?: string,
    @Param('spaceId') routeSpaceId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: AuthenticatedRequest,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const { spaceId: resolvedSpaceId, targetId } = this.resolveCoordinates(
      { spaceId: routeSpaceId, pageId },
      space,
      queryPageId,
      req,
    );
    const { users, realtimeAvailable } =
      await this.presenceService.collectPresence(targetId, resolvedSpaceId);
    return { activeUsers: users, presence: users, realtimeAvailable };
  }

  @Post([
    'docs/:pageId/collaboration/heartbeat',
    'docs/:pageId/presence/heartbeat',
    'spaces/:spaceId/collaboration/heartbeat',
    'spaces/:spaceId/presence/heartbeat',
  ])
  @HttpCode(HttpStatus.OK)
  async sendHeartbeat(
    @Body() body: HeartbeatBody,
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('spaceId') routeSpaceId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    const userName =
      req?.user?.name || req?.user?.email || body?.name || 'Collaborator';
    const bodyPageId =
      typeof body?.pageId === 'string' ? body.pageId : undefined;
    const { spaceId: resolvedSpaceId, targetId } = this.resolveCoordinates(
      { spaceId: routeSpaceId, pageId },
      space,
      queryPageId || bodyPageId,
      req,
    );
    return this.presenceService.recordHeartbeat(
      targetId,
      userId,
      userName,
      body,
      resolvedSpaceId,
    );
  }

  @Post([
    'docs/:pageId/collaboration/leave',
    'docs/:pageId/presence/leave',
    'spaces/:spaceId/collaboration/leave',
    'spaces/:spaceId/presence/leave',
  ])
  @HttpCode(HttpStatus.OK)
  async leaveRoom(
    @Req() req: AuthenticatedRequest,
    @Param('pageId') pageId?: string,
    @Param('spaceId') routeSpaceId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace()
    space?: string | { id: string; spaceId?: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub;
    const { spaceId: resolvedSpaceId, targetId } = this.resolveCoordinates(
      { spaceId: routeSpaceId, pageId },
      space,
      queryPageId,
      req,
    );
    return this.presenceService.leaveRoom(targetId, userId, resolvedSpaceId);
  }
}
