import {
  CanActivate,
  CustomDecorator,
  ExecutionContext,
  Injectable,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import { Socket } from 'socket.io';
import {
  RealtimeAccessDeniedException,
  RealtimeAuthRequiredException,
  RealtimeRoleInsufficientException,
  RealtimeServiceUnavailableException,
} from '../../core/errors';
import { WsRateLimiter } from '../../core/rate-limit';
import {
  PAGES_EVENTS,
  PAGES_REALTIME_DEFAULTS,
  PagesRealtimeConfigService,
  classifyPagesEvent,
  isPersonalSpaceAlias,
} from './config';
import type { ClientSocketData } from './types';
import { RealtimeAccessService } from './access';

export type WsAccessLevel = 'member' | 'read' | 'write' | 'none';

export const WS_ACCESS_LEVEL_KEY = 'ws:access_level';

export const WsAccess = (level: WsAccessLevel): CustomDecorator<string> =>
  SetMetadata(WS_ACCESS_LEVEL_KEY, level);

export interface WsAccessPayload {
  spaceId?: string;
  pageId?: string;
  docId?: string;
}

export interface WsAccessEvaluationContext {
  client: Socket;
  event?: string;
  requiredLevel: WsAccessLevel;
  userId: string;
  data: WsAccessPayload | undefined;
  realtimeAccess: RealtimeAccessService;
}

export function assertRealtimeAccessDecision(
  decision: 'allowed' | 'denied' | 'unavailable',
  deniedMessage: string,
  requiredLevel?: WsAccessLevel,
): void {
  if (decision === 'unavailable') {
    throw new RealtimeServiceUnavailableException();
  }
  if (decision === 'denied') {
    if (requiredLevel === 'write') {
      throw new RealtimeRoleInsufficientException(
        'Insufficient role for document modification (read-only)',
      );
    }
    throw new RealtimeAccessDeniedException(deniedMessage);
  }
}

export interface IWsEventAccessRule {
  readonly name: string;
  matches(ctx: WsAccessEvaluationContext): boolean;
  authorize(ctx: WsAccessEvaluationContext): Promise<boolean>;
}

const ProjectJoinAccessRule: IWsEventAccessRule = {
  name: 'ProjectJoinAccessRule',
  matches: (ctx) => ctx.event === PAGES_EVENTS.PROJECT_JOIN,
  authorize: async (ctx) => {
    const spaceId = ctx.data?.spaceId;
    if (!spaceId) {
      throw new RealtimeAccessDeniedException('Missing spaceId');
    }
    const decision = await ctx.realtimeAccess.checkAccess(
      spaceId,
      ctx.userId,
      'member',
    );
    assertRealtimeAccessDecision(decision, 'Access denied to project');
    return true;
  },
};

const DocJoinAccessRule: IWsEventAccessRule = {
  name: 'DocJoinAccessRule',
  matches: (ctx) => ctx.event === PAGES_EVENTS.DOC_JOIN,
  authorize: async (ctx) => {
    const spaceId = ctx.data?.spaceId;
    const docId = ctx.data?.docId;
    if (!spaceId || !docId) {
      throw new RealtimeAccessDeniedException('Missing spaceId or docId');
    }

    const socketData = ctx.client.data as ClientSocketData | undefined;
    if (socketData?.spaceId !== spaceId) {
      throw new RealtimeAccessDeniedException(
        'Must join space before joining document',
      );
    }

    const belongs = await ctx.realtimeAccess.validateDocInProject(
      spaceId,
      docId,
      typeof socketData.pageId === 'string' ? socketData.pageId : undefined,
    );
    if (!belongs) {
      throw new RealtimeAccessDeniedException(
        'Document does not belong to specified space',
      );
    }

    const decision = await ctx.realtimeAccess.checkAccess(
      spaceId,
      ctx.userId,
      'read',
    );
    assertRealtimeAccessDecision(decision, 'Access denied to document');
    return true;
  },
};

const ActiveDocScopedAccessRule: IWsEventAccessRule = {
  name: 'ActiveDocScopedAccessRule',
  matches: () => true,
  authorize: async (ctx) => {
    const socketData = ctx.client.data as ClientSocketData | undefined;
    const joinedSpaceId = socketData?.spaceId;
    const joinedDocId = socketData?.activeDocId;

    if (!joinedSpaceId) {
      throw new RealtimeAccessDeniedException('Socket has not joined a space');
    }
    if (!joinedDocId) {
      throw new RealtimeAccessDeniedException(
        'Socket has not joined a document',
      );
    }

    if (ctx.data?.spaceId && ctx.data.spaceId !== joinedSpaceId) {
      throw new RealtimeAccessDeniedException(
        'Event payload spaceId does not match socket joined space',
      );
    }
    if (ctx.data?.docId && ctx.data.docId !== joinedDocId) {
      throw new RealtimeAccessDeniedException(
        'Event payload docId does not match socket joined document',
      );
    }

    const decision = await ctx.realtimeAccess.checkAccess(
      joinedSpaceId,
      ctx.userId,
      ctx.requiredLevel,
    );
    assertRealtimeAccessDecision(
      decision,
      'Access denied to document',
      ctx.requiredLevel,
    );
    return true;
  },
};

export const DEFAULT_PAGES_ACCESS_RULES: readonly IWsEventAccessRule[] = [
  ProjectJoinAccessRule,
  DocJoinAccessRule,
  ActiveDocScopedAccessRule,
];

@Injectable()
export class WsAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly realtimeAccess: RealtimeAccessService,
    @Optional()
    private readonly rateLimiter?: WsRateLimiter,
    @Optional()
    private readonly pagesConfig?: PagesRealtimeConfigService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const event = this.reflector.get<string>(
      MESSAGE_METADATA,
      context.getHandler(),
    );

    if (this.rateLimiter && client && event) {
      const policy = this.pagesConfig?.getRateLimitPolicy?.() ?? {
        classify: classifyPagesEvent,
        budgets: PAGES_REALTIME_DEFAULTS.rateLimits,
      };
      this.rateLimiter.consumeOrThrow(client, event, policy);
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
      if (isPersonalSpaceAlias(data.spaceId)) {
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
