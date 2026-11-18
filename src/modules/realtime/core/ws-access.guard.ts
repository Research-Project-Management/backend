import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  Optional,
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
import { RealtimeAccessService } from '../pages/realtime-access.service';
import { WsRateLimiter } from './ws-rate-limiter';

export interface WsAccessEvaluationContext {
  client: Socket;
  event?: string;
  requiredLevel: WsAccessLevel;
  userId: string;
  data: Record<string, any> | undefined;
  realtimeAccess: RealtimeAccessService;
}

/**
 * Template Assertion Helper: Centralizes decision outcome translation into WS domain exceptions.
 */
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

/**
 * Chain of Responsibility Pattern: WebSocket Event Access Rule
 */
export interface IWsEventAccessRule {
  readonly name: string;
  matches(ctx: WsAccessEvaluationContext): boolean;
  authorize(ctx: WsAccessEvaluationContext): Promise<boolean>;
}

const ProjectJoinAccessRule: IWsEventAccessRule = {
  name: 'ProjectJoinAccessRule',
  matches: (ctx) => ctx.event === REALTIME_EVENTS.PROJECT_JOIN,
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
  matches: (ctx) => ctx.event === REALTIME_EVENTS.DOC_JOIN,
  authorize: async (ctx) => {
    const spaceId = ctx.data?.spaceId;
    const docId = ctx.data?.docId;
    if (!spaceId || !docId) {
      throw new RealtimeAccessDeniedException('Missing spaceId or docId');
    }

    if (ctx.client.data?.spaceId !== spaceId) {
      throw new RealtimeAccessDeniedException(
        'Must join space before joining document',
      );
    }

    const belongs = await ctx.realtimeAccess.validateDocInProject(
      spaceId,
      docId,
      typeof ctx.client.data?.pageId === 'string'
        ? ctx.client.data.pageId
        : undefined,
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

const ProjectChatAccessRule: IWsEventAccessRule = {
  name: 'ProjectChatAccessRule',
  matches: (ctx) =>
    ctx.event === REALTIME_EVENTS.CHAT_SEND ||
    ctx.event === REALTIME_EVENTS.CHAT_HISTORY,
  authorize: async (ctx) => {
    const spaceId = ctx.data?.spaceId;
    if (!spaceId || ctx.client.data?.spaceId !== spaceId) {
      throw new RealtimeAccessDeniedException(
        'Socket is not joined to target space',
      );
    }

    const decision = await ctx.realtimeAccess.checkAccess(
      spaceId,
      ctx.userId,
      'member',
    );
    assertRealtimeAccessDecision(decision, 'Access denied to space chat');
    return true;
  },
};

const ActiveDocScopedAccessRule: IWsEventAccessRule = {
  name: 'ActiveDocScopedAccessRule',
  matches: () => true,
  authorize: async (ctx) => {
    const joinedSpaceId = ctx.client.data?.spaceId;
    const joinedDocId = ctx.client.data?.activeDocId;

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

const DEFAULT_WS_ACCESS_RULES: readonly IWsEventAccessRule[] = [
  ProjectJoinAccessRule,
  DocJoinAccessRule,
  ProjectChatAccessRule,
  ActiveDocScopedAccessRule,
];

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

    const data = context.switchToWs().getData();
    const userId = client.data?.userId;
    const authenticated = client.data?.authenticated;

    // Normalize `data.spaceId` -> canonical `spaceId` (handling personal aliases & Page.id)
    // BEFORE returning early on @WsAccess('none') so `project:leave` / `doc:leave` always match!
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

    // If unannotated or 'none', allow execution
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

    for (const rule of DEFAULT_WS_ACCESS_RULES) {
      if (rule.matches(evalCtx)) {
        return rule.authorize(evalCtx);
      }
    }

    return true;
  }
}
