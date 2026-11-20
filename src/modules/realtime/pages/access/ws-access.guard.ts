import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Socket } from 'socket.io';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { RealtimeAuthRequiredException } from '../../core/ws-errors';
import { WsRateLimiter } from '../../core/ws-rate-limiter';
import { classifyPagesEvent } from '../pages.constants';
import type { ClientSocketData } from '../presence/presence.types';
import { WS_ACCESS_LEVEL_KEY, WsAccessLevel } from './ws-access.decorator';
import { RealtimeAccessService } from './realtime-access.service';
import {
  DEFAULT_PAGES_ACCESS_RULES,
  type WsAccessEvaluationContext,
  type WsAccessPayload,
} from './ws-access.rules';

@Injectable()
export class WsAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
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

    if (this.rateLimiter && client && event) {
      this.rateLimiter.consumeOrThrow(client, event, classifyPagesEvent);
    }

    const requiredLevel = this.reflector.getAllAndOverride<WsAccessLevel>(
      WS_ACCESS_LEVEL_KEY,
      [context.getHandler(), context.getClass()],
    );

    const data = context.switchToWs().getData<WsAccessPayload | undefined>();
    const socketData = client.data as ClientSocketData | undefined;
    const userId = socketData?.userId;
    const authenticated = socketData?.authenticated;

    if (data && typeof data === 'object' && typeof data.spaceId === 'string') {
      if (
        ['personal', 'me', 'user', 'default'].includes(
          data.spaceId.trim().toLowerCase(),
        )
      ) {
        if (userId) {
          data.spaceId = userId;
        }
      } else if (
        typeof this.realtimeAccess.resolveCanonicalSpaceAndPage === 'function'
      ) {
        const canonical =
          await this.realtimeAccess.resolveCanonicalSpaceAndPage(
            data.spaceId,
            String(userId || ''),
          );
        if (canonical?.spaceId) {
          if (canonical.pageId && !data.pageId) {
            data.pageId = canonical.pageId;
          }
          data.spaceId = canonical.spaceId;
        }
      }
    }

    if (!requiredLevel || requiredLevel === 'none') {
      return true;
    }

    if (!authenticated || !userId) {
      throw new RealtimeAuthRequiredException('Authentication required');
    }

    const evalCtx: WsAccessEvaluationContext = {
      client,
      event,
      requiredLevel,
      userId,
      data,
      realtimeAccess: this.realtimeAccess,
    };

    for (const rule of DEFAULT_PAGES_ACCESS_RULES) {
      if (rule.matches(evalCtx)) {
        return rule.authorize(evalCtx);
      }
    }

    return true;
  }
}
