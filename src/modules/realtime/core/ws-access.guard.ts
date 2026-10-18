import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Socket } from 'socket.io';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { WS_ACCESS_LEVEL_KEY, WsAccessLevel } from './ws-access.decorator';
import {
  RealtimeAuthRequiredException,
  RealtimeAccessDeniedException,
  RealtimeRoleInsufficientException,
  RealtimeServiceUnavailableException,
} from './ws-errors';
import { REALTIME_EVENTS } from './realtime.constant';
import { RealtimeAccessService } from '../manuscripts/realtime-access.service';
import { WsRateLimiter } from './ws-rate-limiter';

/**
 * Enterprise WebSocket Access Guard
 * Enforces declarative @WsAccess('read' | 'write' | 'member' | 'none') metadata,
 * verifies project/document joined context binding, prevents IDOR and reviewer write bypass.
 */
@Injectable()
export class WsAccessGuard implements CanActivate {
  private readonly logger = new Logger(WsAccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(forwardRef(() => RealtimeAccessService))
    private readonly realtimeAccess: RealtimeAccessService,
    @Optional()
    private readonly rateLimiter?: WsRateLimiter,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const event = this.reflector.get<string>(
      MESSAGE_METADATA,
      context.getHandler(),
    );

    // 0. Enforce Rate Limiting if event is classified
    if (this.rateLimiter && client && event) {
      this.rateLimiter.consumeOrThrow(client, event);
    }

    const requiredLevel = this.reflector.getAllAndOverride<WsAccessLevel>(
      WS_ACCESS_LEVEL_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If unannotated or 'none', allow execution
    if (!requiredLevel || requiredLevel === 'none') {
      return true;
    }

    const data = context.switchToWs().getData();

    const userId = client.data?.userId;
    const authenticated = client.data?.authenticated;

    if (!authenticated || !userId) {
      throw new RealtimeAuthRequiredException('Authentication required');
    }

    // 1. Project Join
    if (event === REALTIME_EVENTS.PROJECT_JOIN) {
      const projectId = data?.projectId;
      if (!projectId) {
        throw new RealtimeAccessDeniedException('Missing projectId');
      }
      const decision = await this.realtimeAccess.checkAccess(
        projectId,
        userId,
        'member',
      );
      if (decision === 'unavailable') {
        throw new RealtimeServiceUnavailableException();
      }
      if (decision === 'denied') {
        throw new RealtimeAccessDeniedException('Access denied to project');
      }
      return true;
    }

    // 2. Document Join
    if (event === REALTIME_EVENTS.DOC_JOIN) {
      const projectId = data?.projectId;
      const docId = data?.docId;
      if (!projectId || !docId) {
        throw new RealtimeAccessDeniedException('Missing projectId or docId');
      }

      // Socket must have joined project first
      if (client.data?.projectId !== projectId) {
        throw new RealtimeAccessDeniedException(
          'Must join project before joining document',
        );
      }

      // Verify document belongs to project (RT-04)
      const belongs = await this.realtimeAccess.validateDocInProject(
        projectId,
        docId,
      );
      if (!belongs) {
        throw new RealtimeAccessDeniedException(
          'Document does not belong to specified project',
        );
      }

      const decision = await this.realtimeAccess.checkAccess(
        projectId,
        userId,
        'read',
      );
      if (decision === 'unavailable') {
        throw new RealtimeServiceUnavailableException();
      }
      if (decision === 'denied') {
        throw new RealtimeAccessDeniedException('Access denied to document');
      }
      return true;
    }

    // 3. Project Chat Events (chat:send, chat:history)
    if (
      event === REALTIME_EVENTS.CHAT_SEND ||
      event === REALTIME_EVENTS.CHAT_HISTORY
    ) {
      const projectId = data?.projectId;
      if (!projectId || client.data?.projectId !== projectId) {
        throw new RealtimeAccessDeniedException(
          'Socket is not joined to target project',
        );
      }

      const decision = await this.realtimeAccess.checkAccess(
        projectId,
        userId,
        'member',
      );
      if (decision === 'unavailable') {
        throw new RealtimeServiceUnavailableException();
      }
      if (decision === 'denied') {
        throw new RealtimeAccessDeniedException(
          'Access denied to project chat',
        );
      }
      return true;
    }

    // 4. Document-Scoped Events (update, cursor, sync:step1, sync:step2, sync:update)
    const joinedProjectId = client.data?.projectId;
    const joinedDocId = client.data?.activeDocId;

    if (!joinedProjectId) {
      throw new RealtimeAccessDeniedException(
        'Socket has not joined a project',
      );
    }
    if (!joinedDocId) {
      throw new RealtimeAccessDeniedException(
        'Socket has not joined a document',
      );
    }

    // Verify payload targets joined context
    if (data?.projectId && data.projectId !== joinedProjectId) {
      throw new RealtimeAccessDeniedException(
        'Event payload projectId does not match socket joined project',
      );
    }
    if (data?.docId && data.docId !== joinedDocId) {
      throw new RealtimeAccessDeniedException(
        'Event payload docId does not match socket joined document',
      );
    }

    const decision = await this.realtimeAccess.checkAccess(
      joinedProjectId,
      userId,
      requiredLevel,
    );

    if (decision === 'unavailable') {
      throw new RealtimeServiceUnavailableException();
    }

    if (decision === 'denied') {
      if (requiredLevel === 'write') {
        throw new RealtimeRoleInsufficientException(
          'Insufficient role for document modification (read-only)',
        );
      }
      throw new RealtimeAccessDeniedException('Access denied to document');
    }

    return true;
  }
}
