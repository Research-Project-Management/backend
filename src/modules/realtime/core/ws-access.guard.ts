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
    const projectId = ctx.data?.projectId;
    if (!projectId) {
      throw new RealtimeAccessDeniedException('Missing projectId');
    }
    const decision = await ctx.realtimeAccess.checkAccess(
      projectId,
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
    const projectId = ctx.data?.projectId;
    const docId = ctx.data?.docId;
    if (!projectId || !docId) {
      throw new RealtimeAccessDeniedException('Missing projectId or docId');
    }

    if (ctx.client.data?.projectId !== projectId) {
      throw new RealtimeAccessDeniedException(
        'Must join project before joining document',
      );
    }

    const belongs = await ctx.realtimeAccess.validateDocInProject(
      projectId,
      docId,
    );
    if (!belongs) {
      throw new RealtimeAccessDeniedException(
        'Document does not belong to specified project',
      );
    }

    const decision = await ctx.realtimeAccess.checkAccess(
      projectId,
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
    const projectId = ctx.data?.projectId;
    if (!projectId || ctx.client.data?.projectId !== projectId) {
      throw new RealtimeAccessDeniedException(
        'Socket is not joined to target project',
      );
    }

    const decision = await ctx.realtimeAccess.checkAccess(
      projectId,
      ctx.userId,
      'member',
    );
    assertRealtimeAccessDecision(decision, 'Access denied to project chat');
    return true;
  },
};

const ActiveDocScopedAccessRule: IWsEventAccessRule = {
  name: 'ActiveDocScopedAccessRule',
  matches: () => true,
  authorize: async (ctx) => {
    const joinedProjectId = ctx.client.data?.projectId;
    const joinedDocId = ctx.client.data?.activeDocId;

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

    if (ctx.data?.projectId && ctx.data.projectId !== joinedProjectId) {
      throw new RealtimeAccessDeniedException(
        'Event payload projectId does not match socket joined project',
      );
    }
    if (ctx.data?.docId && ctx.data.docId !== joinedDocId) {
      throw new RealtimeAccessDeniedException(
        'Event payload docId does not match socket joined document',
      );
    }

    const decision = await ctx.realtimeAccess.checkAccess(
      joinedProjectId,
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
