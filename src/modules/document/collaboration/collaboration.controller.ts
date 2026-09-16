import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Sse,
  UseGuards,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Observable, fromEvent } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollaborationService } from './collaboration.service';
import { HeartbeatDto } from './dto/collaboration.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Collaboration')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class CollaborationController {
  constructor(
    private readonly collaborationService: CollaborationService,
    private readonly eventEmitter?: EventEmitter2,
  ) {}

  @Sse('projects/:projectId/pages/:pageId/collaboration/stream')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Real-time SSE event stream for live cursors, presence and locks',
  })
  streamCollaborationEvents(
    @Param('pageId') pageId: string,
    @Req() req: FastifyRequest,
  ): Observable<MessageEvent> {
    if (!this.eventEmitter) {
      return new Observable<MessageEvent>();
    }

    const disconnect$ = fromEvent(req.raw, 'close');

    return fromEvent(this.eventEmitter, 'document.collaboration.event').pipe(
      filter((event: any) => event?.pageId === pageId),
      map((event: any) => ({
        data: event,
      })),
      takeUntil(disconnect$),
    );
  }

  @Sse('pages/:pageId/collaboration/stream')
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Real-time SSE event stream for live cursors, presence and locks (direct page route)',
  })
  streamCollaborationEventsDirect(
    @Param('pageId') pageId: string,
    @Req() req: FastifyRequest,
  ): Observable<MessageEvent> {
    return this.streamCollaborationEvents(pageId, req);
  }

  @Get([
    'pages/:pageId/collaboration/presence',
    'projects/:projectId/pages/:pageId/collaboration/presence',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get current active users viewing or editing this document',
  })
  async getActiveUsers(@Param('pageId') pageId: string) {
    const activeUsers = this.collaborationService.getActiveUsers(pageId);
    return { activeUsers };
  }

  @Post([
    'pages/:pageId/collaboration/heartbeat',
    'projects/:projectId/pages/:pageId/collaboration/heartbeat',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send presence heartbeat & broadcast cursor position',
  })
  async sendHeartbeat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: HeartbeatDto,
  ) {
    const role = req.role || 'viewer';
    const activeUsers = await this.collaborationService.updatePresence(
      pageId,
      {
        id: userId,
        name: user?.name || user?.email || 'Researcher',
        avatar: user?.avatar,
        role,
      },
      dto.cursor,
    );

    return { activeUsers };
  }

  @Post([
    'pages/:pageId/collaboration/leave',
    'projects/:projectId/pages/:pageId/collaboration/leave',
  ])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Explicitly signal leaving document room' })
  async leaveRoom(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    const activeUsers = await this.collaborationService.leaveRoom(
      pageId,
      userId,
    );
    return { activeUsers };
  }
}
