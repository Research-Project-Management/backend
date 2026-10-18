/**
 * modules/manuscripts/docstore/services/manuscript-presence.service.ts
 * Domain/Application service managing HTTP fallback presence, WebSocket presence merging,
 * and Server-Sent Events (SSE) collaboration stream notifications.
 */

import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '@/core';
import { isOriginAllowed } from '@/core/http/setup/allowed-origins';
import type { FastifyReply } from 'fastify';
import { LiveCollaborationPort, LivePresenceUser } from '../domain';

export interface ActivePresenceUser {
  id: string;
  userId?: string;
  name: string;
  color: string;
  lastSeen: number;
  fileId: string | null;
  cursor?: Record<string, unknown> | null;
  lastHeartbeat?: number;
  transport?: string;
}

export interface HeartbeatBody {
  name?: string;
  color?: string;
  cursor?: Record<string, unknown> | null;
  userId?: string;
  [key: string]: unknown;
}

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@Injectable()
export class ManuscriptPresenceService {
  private readonly logger = new Logger(ManuscriptPresenceService.name);
  private static readonly HTTP_PRESENCE_TTL_MS = 60_000;
  private static readonly httpPresence = new Map<string, ActivePresenceUser>();
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private getLiveCollaboration(): LiveCollaborationPort | null {
    if (this.liveCollab !== undefined) return this.liveCollab;
    try {
      this.liveCollab =
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null;
    } catch {
      this.liveCollab = null;
    }
    return this.liveCollab;
  }

  private async resolveProjectId(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id },
      select: { projectId: true },
    });
    if (doc?.projectId) return doc.projectId;
    const node = await this.prisma.manuscriptNode.findFirst({
      where: { projectId: id },
      select: { projectId: true },
    });
    return node?.projectId ?? null;
  }

  /**
   * Merged presence: WebSocket sessions (authoritative, via realtime port) plus
   * HTTP-heartbeat clients (fallback transport), de-duplicated by userId.
   */
  public async collectPresence(pageId: string): Promise<{
    users: Array<LivePresenceUser | ActivePresenceUser>;
    realtimeAvailable: boolean;
  }> {
    const now = Date.now();
    const byUser = new Map<string, LivePresenceUser | ActivePresenceUser>();

    for (const [key, user] of ManuscriptPresenceService.httpPresence) {
      if (
        now - user.lastSeen >
        ManuscriptPresenceService.HTTP_PRESENCE_TTL_MS
      ) {
        ManuscriptPresenceService.httpPresence.delete(key);
      } else if (user.fileId === pageId) {
        byUser.set(user.id, {
          ...user,
          userId: user.id,
          lastHeartbeat: user.lastSeen,
          transport: 'http',
        });
      }
    }

    const live = this.getLiveCollaboration();
    if (live) {
      const projectId = await this.resolveProjectId(pageId);
      if (projectId) {
        try {
          for (const u of await live.getPresence(projectId, pageId)) {
            byUser.set(u.userId, {
              ...u,
              lastHeartbeat: u.lastSeen,
              transport: 'websocket',
            });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Live presence lookup failed: ${message}`);
        }
      }
    }
    return { users: [...byUser.values()], realtimeAvailable: !!live };
  }

  public recordHeartbeat(
    pageId: string,
    userId: string | undefined,
    userName: string,
    body?: HeartbeatBody,
  ): { success: true } {
    if (!userId) {
      throw new BadRequestException('Authenticated user required');
    }
    ManuscriptPresenceService.httpPresence.set(`${pageId}:${userId}`, {
      id: userId,
      name: userName,
      color: body?.color || '#2563EB',
      fileId: pageId,
      cursor: body?.cursor,
      lastSeen: Date.now(),
    });
    return { success: true };
  }

  public leaveRoom(pageId: string, userId?: string): { success: true } {
    if (userId) {
      ManuscriptPresenceService.httpPresence.delete(`${pageId}:${userId}`);
    }
    return { success: true };
  }

  public formatSseEvent(
    pageId: string,
    payload: Record<string, unknown>,
  ): string {
    return `data: ${JSON.stringify({ pageId, timestamp: Date.now(), ...payload })}\n\n`;
  }

  public async streamPresenceAndUpdates(
    pageId: string,
    origin: string | undefined,
    rawRequest: { on(event: 'close', listener: () => void): void },
    reply: FastifyReply,
  ): Promise<void> {
    if (origin && isOriginAllowed(origin)) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.writeHead(200);

    const send = (payload: Record<string, unknown>) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(this.formatSseEvent(pageId, payload));
    };

    let lastPresenceKey = '';
    let lastVersion: number | null = null;
    let closed = false;

    const tick = async () => {
      if (closed) return;
      try {
        const { users } = await this.collectPresence(pageId);
        const key = users
          .map(
            (u: LivePresenceUser | ActivePresenceUser) =>
              `${u.userId}:${JSON.stringify(u.cursor ?? null)}`,
          )
          .sort()
          .join('|');
        if (key !== lastPresenceKey) {
          lastPresenceKey = key;
          send({ type: 'presence', users });
        }
        if (isUuid(pageId)) {
          const doc = await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
            select: { version: true },
          });
          if (doc) {
            if (lastVersion !== null && doc.version !== lastVersion) {
              send({ type: 'content-updated', version: doc.version });
            }
            lastVersion = doc.version;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`SSE tick failed for ${pageId}: ${message}`);
      }
    };

    await tick();
    const poll = setInterval(() => void tick(), 3000);
    const keepalive = setInterval(() => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(': keepalive\n\n');
      }
    }, 15000);

    rawRequest.on('close', () => {
      closed = true;
      clearInterval(poll);
      clearInterval(keepalive);
    });
  }
}
