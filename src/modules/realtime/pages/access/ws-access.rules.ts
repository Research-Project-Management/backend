import { Socket } from 'socket.io';
import {
  RealtimeAccessDeniedException,
  RealtimeRoleInsufficientException,
  RealtimeServiceUnavailableException,
} from '../../core/ws-errors';
import { PAGES_EVENTS } from '../pages.constants';
import type { ClientSocketData } from '../presence/presence.types';
import type { WsAccessLevel } from './ws-access.decorator';
import type { RealtimeAccessService } from './realtime-access.service';

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

const ProjectChatAccessRule: IWsEventAccessRule = {
  name: 'ProjectChatAccessRule',
  matches: (ctx) =>
    ctx.event === PAGES_EVENTS.CHAT_SEND ||
    ctx.event === PAGES_EVENTS.CHAT_HISTORY,
  authorize: async (ctx) => {
    const spaceId = ctx.data?.spaceId;
    const socketData = ctx.client.data as ClientSocketData | undefined;
    if (!spaceId || socketData?.spaceId !== spaceId) {
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
  ProjectChatAccessRule,
  ActiveDocScopedAccessRule,
];
