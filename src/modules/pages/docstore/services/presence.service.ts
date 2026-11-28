/**
 * modules/pages/docstore/services/presence.service.ts
 * Domain/Application service managing HTTP presence and WebSocket presence merging.
 */

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  BadRequestException,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/pages/core/ports/live-collaboration.port';

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

const COLOR_HEX_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function sanitizePresenceColor(color?: string | null): string {
  if (!color || typeof color !== 'string') return '#2563EB';
  const trimmed = color.trim();
  return COLOR_HEX_REGEX.test(trimmed) ? trimmed : '#2563EB';
}

function sanitizeCursorPayload(
  cursor?: Record<string, unknown> | null,
): Record<string, unknown> | null | undefined {
  if (!cursor || typeof cursor !== 'object') return cursor;
  const out: Record<string, unknown> = {};
  for (const key of ['line', 'column', 'ch', 'head', 'anchor', 'from', 'to']) {
    const val = cursor[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[key] = Math.max(0, Math.min(1_000_000, Math.floor(val)));
    }
  }
  return out;
}

@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private static readonly HTTP_PRESENCE_TTL_MS = 60_000;
  private static readonly MAX_HTTP_PRESENCE_ENTRIES = 5000;
  private static readonly PROJECT_ID_CACHE_TTL_MS = 300_000; // 5 minutes
  private static readonly PRESENCE_CACHE_TTL_MS = 1_000; // 1 second single-flight + short TTL cache
  private readonly httpPresence = new Map<string, ActivePresenceUser>();
  private readonly projectIdCache = new Map<
    string,
    { projectId: string | null; expiresAt: number }
  >();
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
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
  ) {
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort).getPresence ===
        'function' &&
      !(liveCollabOrLegacyRef as { isNoop?: boolean }).isNoop
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : null;
  }

  public onModuleDestroy(): void {
    this.presenceCache.clear();
    this.httpPresence.clear();
    this.projectIdCache.clear();
    this.liveCollab = undefined;
  }

  private getLiveCollaboration(): LiveCollaborationPort | null {
    return this.liveCollab ?? null;
  }

  private async resolveProjectId(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;

    const cached = this.projectIdCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.projectId;
    }

    const doc = await this.prisma.pageDoc.findUnique({
      where: { id },
      select: { spaceId: true },
    });
    let resolved =
      doc?.spaceId ?? (doc as { projectId?: string } | null)?.projectId ?? null;
    if (!resolved) {
      const node = await this.prisma.pageNode.findFirst({
        where: { OR: [{ id }, { spaceId: id }] },
        select: { spaceId: true },
      });
      resolved =
        node?.spaceId ??
        (node as { projectId?: string } | null)?.projectId ??
        null;
    }

    if (this.projectIdCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of this.projectIdCache) {
        if (v.expiresAt <= now) {
          this.projectIdCache.delete(k);
        }
      }
      if (this.projectIdCache.size > 2000) {
        const oldestKey = this.projectIdCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.projectIdCache.delete(oldestKey);
        }
      }
    }
    this.projectIdCache.set(id, {
      projectId: resolved,
      expiresAt: Date.now() + PresenceService.PROJECT_ID_CACHE_TTL_MS,
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
      expiresAt: now + PresenceService.PRESENCE_CACHE_TTL_MS,
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

    for (const [key, user] of this.httpPresence) {
      if (now - user.lastSeen > PresenceService.HTTP_PRESENCE_TTL_MS) {
        this.httpPresence.delete(key);
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
    if (this.httpPresence.size >= PresenceService.MAX_HTTP_PRESENCE_ENTRIES) {
      // Evict expired entries first, then evict the oldest entry (FIFO/LRU)
      const now = Date.now();
      for (const [k, v] of this.httpPresence) {
        if (now - v.lastSeen > PresenceService.HTTP_PRESENCE_TTL_MS) {
          this.httpPresence.delete(k);
        }
      }
      if (this.httpPresence.size >= PresenceService.MAX_HTTP_PRESENCE_ENTRIES) {
        const oldestKey = this.httpPresence.keys().next().value;
        if (oldestKey !== undefined) {
          this.httpPresence.delete(oldestKey);
        }
      }
    }
    const presenceKey = authorizedProjectId
      ? `${authorizedProjectId}:${pageId}:${userId}`
      : `${pageId}:${userId}`;
    this.httpPresence.set(presenceKey, {
      id: userId,
      name: String(userName || 'Collaborator').slice(0, 120),
      color: sanitizePresenceColor(body?.color),
      fileId: pageId,
      projectId: authorizedProjectId ?? null,
      cursor: sanitizeCursorPayload(body?.cursor),
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
      this.httpPresence.delete(`${pageId}:${userId}`);
      if (authorizedProjectId) {
        this.httpPresence.delete(`${authorizedProjectId}:${pageId}:${userId}`);
      }
    }
    this.presenceCache.delete(pageId);
    if (authorizedProjectId) {
      this.presenceCache.delete(`${authorizedProjectId}:${pageId}`);
    }
    return { success: true };
  }
}
