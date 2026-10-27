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
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { isOriginAllowed } from '@/core/http/setup/allowed-origins';
import type { FastifyReply } from 'fastify';
import {
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/manuscripts/core';

export interface ActivePresenceUser {
  id: string;
  userId?: string;
  name: string;
  color: string;
  lastSeen: number;
  fileId: string | null;
  projectId?: string | null;
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

@Injectable()
export class ManuscriptPresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(ManuscriptPresenceService.name);
  private static readonly HTTP_PRESENCE_TTL_MS = 60_000;
  private static readonly MAX_HTTP_PRESENCE_ENTRIES = 5000;
  private static readonly httpPresence = new Map<string, ActivePresenceUser>();
  private static readonly projectIdCache = new Map<
    string,
    { projectId: string | null; expiresAt: number }
  >();
  private static readonly PROJECT_ID_CACHE_TTL_MS = 300_000; // 5 minutes
  private static readonly PRESENCE_CACHE_TTL_MS = 1_000; // 1 second single-flight + short TTL cache
  private readonly presenceCache = new Map<
    string,
    {
      expiresAt: number;
      promise: Promise<{
        users: Array<LivePresenceUser | ActivePresenceUser>;
        realtimeAvailable: boolean;
      }>;
    }
  >();
  private readonly activeSseCleanups = new Set<() => void>();
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  public onModuleDestroy(): void {
    for (const cleanup of this.activeSseCleanups) {
      cleanup();
    }
    this.activeSseCleanups.clear();
    this.presenceCache.clear();
    this.liveCollab = undefined;
  }

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

    const cached = ManuscriptPresenceService.projectIdCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.projectId;
    }

    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id },
      select: { projectId: true },
    });
    let resolved = doc?.projectId ?? null;
    if (!resolved) {
      const node = await this.prisma.manuscriptNode.findFirst({
        where: { OR: [{ id }, { projectId: id }] },
        select: { projectId: true },
      });
      resolved = node?.projectId ?? null;
    }

    if (ManuscriptPresenceService.projectIdCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of ManuscriptPresenceService.projectIdCache) {
        if (v.expiresAt <= now) {
          ManuscriptPresenceService.projectIdCache.delete(k);
        }
      }
      if (ManuscriptPresenceService.projectIdCache.size > 2000) {
        const oldestKey = ManuscriptPresenceService.projectIdCache
          .keys()
          .next().value;
        if (oldestKey !== undefined) {
          ManuscriptPresenceService.projectIdCache.delete(oldestKey);
        }
      }
    }
    ManuscriptPresenceService.projectIdCache.set(id, {
      projectId: resolved,
      expiresAt: Date.now() + ManuscriptPresenceService.PROJECT_ID_CACHE_TTL_MS,
    });

    return resolved;
  }

  private async verifyPageInProject(
    pageId: string,
    authorizedProjectId?: string,
  ): Promise<string | null> {
    if (!authorizedProjectId) {
      return this.resolveProjectId(pageId);
    }
    if (pageId === authorizedProjectId) {
      return authorizedProjectId;
    }
    const resolved = await this.resolveProjectId(pageId);
    if (!resolved || resolved !== authorizedProjectId) {
      throw new NotFoundException(`Document ${pageId} not found in project`);
    }
    return resolved;
  }

  /**
   * Merged presence: WebSocket sessions (authoritative, via realtime port) plus
   * HTTP-heartbeat clients (fallback transport), de-duplicated by userId.
   */
  public async collectPresence(
    pageId: string,
    authorizedProjectId?: string,
  ): Promise<{
    users: Array<LivePresenceUser | ActivePresenceUser>;
    realtimeAvailable: boolean;
  }> {
    if (authorizedProjectId) {
      await this.verifyPageInProject(pageId, authorizedProjectId);
    }
    const cacheKey = authorizedProjectId
      ? `${authorizedProjectId}:${pageId}`
      : pageId;
    const now = Date.now();
    const cached = this.presenceCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const promise = this.fetchPresence(pageId, authorizedProjectId).catch(
      (err) => {
        this.presenceCache.delete(cacheKey);
        throw err;
      },
    );

    if (this.presenceCache.size >= 2000) {
      for (const [k, v] of this.presenceCache) {
        if (v.expiresAt <= now) {
          this.presenceCache.delete(k);
        }
      }
      if (this.presenceCache.size >= 2000) {
        const oldestKey = this.presenceCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.presenceCache.delete(oldestKey);
        }
      }
    }

    this.presenceCache.set(cacheKey, {
      expiresAt: now + ManuscriptPresenceService.PRESENCE_CACHE_TTL_MS,
      promise,
    });
    return promise;
  }

  private async fetchPresence(
    pageId: string,
    authorizedProjectId?: string,
  ): Promise<{
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
      } else if (
        user.fileId === pageId &&
        (!authorizedProjectId ||
          !user.projectId ||
          user.projectId === authorizedProjectId)
      ) {
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
      const projectId =
        authorizedProjectId ?? (await this.resolveProjectId(pageId));
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

  public async recordHeartbeat(
    pageId: string,
    userId: string | undefined,
    userName: string,
    body?: HeartbeatBody,
    authorizedProjectId?: string,
  ): Promise<{ success: true }> {
    if (!userId) {
      throw new BadRequestException('Authenticated user required');
    }
    if (authorizedProjectId) {
      await this.verifyPageInProject(pageId, authorizedProjectId);
    }
    if (
      ManuscriptPresenceService.httpPresence.size >=
      ManuscriptPresenceService.MAX_HTTP_PRESENCE_ENTRIES
    ) {
      // Evict expired entries first, then evict the oldest entry (FIFO/LRU)
      const now = Date.now();
      for (const [k, v] of ManuscriptPresenceService.httpPresence) {
        if (now - v.lastSeen > ManuscriptPresenceService.HTTP_PRESENCE_TTL_MS) {
          ManuscriptPresenceService.httpPresence.delete(k);
        }
      }
      if (
        ManuscriptPresenceService.httpPresence.size >=
        ManuscriptPresenceService.MAX_HTTP_PRESENCE_ENTRIES
      ) {
        const oldestKey = ManuscriptPresenceService.httpPresence
          .keys()
          .next().value;
        if (oldestKey !== undefined) {
          ManuscriptPresenceService.httpPresence.delete(oldestKey);
        }
      }
    }
    const presenceKey = authorizedProjectId
      ? `${authorizedProjectId}:${pageId}:${userId}`
      : `${pageId}:${userId}`;
    ManuscriptPresenceService.httpPresence.set(presenceKey, {
      id: userId,
      name: userName,
      color: body?.color || '#2563EB',
      fileId: pageId,
      projectId: authorizedProjectId ?? null,
      cursor: body?.cursor,
      lastSeen: Date.now(),
    });
    this.presenceCache.delete(pageId);
    if (authorizedProjectId) {
      this.presenceCache.delete(`${authorizedProjectId}:${pageId}`);
    }
    return { success: true };
  }

  public async leaveRoom(
    pageId: string,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<{ success: true }> {
    if (authorizedProjectId) {
      await this.verifyPageInProject(pageId, authorizedProjectId);
    }
    if (userId) {
      ManuscriptPresenceService.httpPresence.delete(`${pageId}:${userId}`);
      if (authorizedProjectId) {
        ManuscriptPresenceService.httpPresence.delete(
          `${authorizedProjectId}:${pageId}:${userId}`,
        );
      }
    }
    this.presenceCache.delete(pageId);
    if (authorizedProjectId) {
      this.presenceCache.delete(`${authorizedProjectId}:${pageId}`);
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
    authorizedProjectId?: string,
  ): Promise<void> {
    if (authorizedProjectId) {
      await this.verifyPageInProject(pageId, authorizedProjectId);
    }
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
    let closed = false;

    const onProjectEvent = (evt: {
      projectId?: string;
      event?: string;
      payload?: { docId?: string; version?: number };
    }) => {
      if (closed) return;
      if (
        authorizedProjectId &&
        evt?.projectId &&
        evt.projectId !== authorizedProjectId
      ) {
        return;
      }
      if (
        evt?.event === 'doc:content-updated' &&
        evt.payload?.docId === pageId
      ) {
        send({ type: 'content-updated', version: evt.payload.version });
      }
    };

    this.eventEmitter?.on('manuscripts.project.event', onProjectEvent);

    const tick = async () => {
      if (closed) return;
      try {
        const { users } = await this.collectPresence(
          pageId,
          authorizedProjectId,
        );
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

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(keepalive);
      this.eventEmitter?.off('manuscripts.project.event', onProjectEvent);
      this.activeSseCleanups.delete(cleanup);
    };

    this.activeSseCleanups.add(cleanup);
    rawRequest.on('close', cleanup);
  }
}
