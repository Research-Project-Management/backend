import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemResourceGovernor } from '@/core/infrastructure/resource/system-resource-governor';
import {
  REALTIME_CORE_DEFAULTS,
  RealtimeConfigService,
  parsePositiveInt,
  type RateLimitBudget,
} from '../../core/config';
import type { WsRateLimitPolicy } from '../../core/rate-limit';

export const PAGES_EVENTS = {
  // Space / Project-level lifecycle & broadcast events
  PROJECT_JOIN: 'project:join',
  PROJECT_LEAVE: 'project:leave',
  USER_JOINED_PROJECT: 'project:user-joined',
  USER_LEFT_PROJECT: 'project:user-left',

  // Document-level collaboration events
  DOC_JOIN: 'doc:join',
  DOC_LEAVE: 'doc:leave',
  USER_JOINED_DOC: 'doc:user-joined',
  USER_LEFT_DOC: 'doc:user-left',
  DOC_CURSOR: 'doc:cursor',
  DOC_EVICTED: 'doc:evicted',
  DOC_PERSISTED: 'doc:persisted',

  // Binary Yjs CRDT sync events
  YJS_SYNC_STEP_1: 'doc:sync:step1',
  YJS_SYNC_STEP_2: 'doc:sync:step2',
  YJS_SYNC_UPDATE: 'doc:sync:update',

  // External pages subsystem broadcast events
  FILE_TREE_UPDATE: 'fileTree:update',
  COMPILE_PROGRESS: 'compile:progress',
  HISTORY_NEW_VERSION: 'history:new-version',

  // Realtime access & revocation events
  ACCESS_REVOKED: 'access:revoked',
  ACCESS_UPDATED: 'access:updated',
} as const;

export const PAGES_ROOMS = {
  project: (spaceId: string): string => `project:${spaceId}`,
  doc: (spaceId: string, docId: string): string => `doc:${spaceId}:${docId}`,
} as const;

export const PAGES_REDIS_KEYS = {
  presence: (socketId: string): string => `page:presence:${socketId}`,
  projectRoom: (spaceId: string): string => `page:project_rooms:${spaceId}`,
  docRoom: (spaceId: string, docId: string): string =>
    `page:doc_rooms:${spaceId}:${docId}`,
  yjsBinary: (spaceId: string, docId: string): string =>
    `page:crdt:bin:${spaceId}:${docId}`,
  yjsMeta: (spaceId: string, docId: string): string =>
    `page:crdt:meta:${spaceId}:${docId}`,
  yjsFlushLock: (spaceId: string, docId: string): string =>
    `lock:yjs:flush:${spaceId}:${docId}`,
} as const;

export const PAGES_REDIS_CHANNELS = {
  YJS_CLUSTER: 'page:crdt:cluster',
} as const;

export const PAGES_DOMAIN_EVENTS = {
  FILE_TREE_CHANGE: 'pages.file-tree.change',
  PROJECT_EVENT: 'pages.project.event',
  PAGE_DELETED: 'pages.page.deleted',
} as const;

export type PagesRateBucket = 'cursor' | 'update' | 'joinLeave';

const PAGES_RATE_CLASS_MAP: Readonly<Record<string, PagesRateBucket>> =
  Object.freeze({
    [PAGES_EVENTS.DOC_CURSOR]: 'cursor',
    [PAGES_EVENTS.YJS_SYNC_STEP_1]: 'update',
    [PAGES_EVENTS.YJS_SYNC_STEP_2]: 'update',
    [PAGES_EVENTS.YJS_SYNC_UPDATE]: 'update',
    [PAGES_EVENTS.PROJECT_JOIN]: 'joinLeave',
    [PAGES_EVENTS.PROJECT_LEAVE]: 'joinLeave',
    [PAGES_EVENTS.DOC_JOIN]: 'joinLeave',
    [PAGES_EVENTS.DOC_LEAVE]: 'joinLeave',
  });

export function classifyPagesEvent(eventName: string): PagesRateBucket | null {
  return PAGES_RATE_CLASS_MAP[eventName] ?? null;
}

export const PAGES_PRESENCE_COLORS: readonly string[] = Object.freeze([
  '#3B82F6',
  '#EF4444',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4',
  '#84CC16',
  '#F97316',
  '#6366F1',
  '#14B8A6',
  '#D946EF',
]);

const PAGES_PERSONAL_SPACE_ALIASES: ReadonlySet<string> = new Set([
  'personal',
  'me',
  'user',
  'default',
]);

export function isPersonalSpaceAlias(spaceId: unknown): spaceId is string {
  return (
    typeof spaceId === 'string' &&
    PAGES_PERSONAL_SPACE_ALIASES.has(spaceId.trim().toLowerCase())
  );
}

export interface PagesYjsConfig {
  maxUpdateSizeBytes: number;
  maxDocumentSizeBytes: number;
  flushDebounceMs: number;
  maxFlushDelayMs: number;
  flushRetryDelayMs: number;
  flushLockTtlMs: number;
  idleThresholdMs: number;
  maxActiveDocs: number;
  sweepIntervalMs: number;
  redisSnapshotTtlSeconds: number;
}

export interface PagesAccessConfig {
  cacheTtlSeconds: number;
  maxCacheEntries: number;
}

export interface PagesPresenceConfig {
  cursorRedisThrottleMs: number;
  sessionTtlSeconds: number;
}

export interface PagesSessionConfig {
  backgroundRetryDelayMs: number;
}

export type PagesRateLimitBudgets = Record<PagesRateBucket, RateLimitBudget>;

export const PAGES_REALTIME_DEFAULTS = {
  yjs: {
    maxUpdateSizeBytes: 512 * 1024, // 512 KiB
    maxDocumentSizeBytes: 20 * 1024 * 1024, // 20 MiB
    flushDebounceMs: 2_000,
    maxFlushDelayMs: 10_000,
    flushRetryDelayMs: 1_500,
    flushLockTtlMs: 10_000,
    idleThresholdMs: 15 * 60 * 1000,
    maxActiveDocs: 2_000,
    sweepIntervalMs: 5 * 60 * 1000,
    redisSnapshotTtlSeconds: 7 * 24 * 3600,
  },
  access: {
    cacheTtlSeconds: 30,
    maxCacheEntries: 2_000,
  },
  presence: {
    cursorRedisThrottleMs: 2_000,
    sessionTtlSeconds: 86_400,
  },
  session: {
    backgroundRetryDelayMs: 1_000,
  },
  rateLimits: {
    cursor: { budgetPerSec: 20, burst: 40 },
    update: { budgetPerSec: 50, burst: 100 },
    joinLeave: { budgetPerSec: 5, burst: 10 },
  },
} as const;

@Injectable()
export class PagesRealtimeConfigService {
  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly coreConfig?: RealtimeConfigService,
    @Optional() private readonly resourceGovernor?: SystemResourceGovernor,
  ) {}

  public getYjsConfig(): PagesYjsConfig {
    return {
      maxUpdateSizeBytes: this.parseNum(
        'REALTIME_MAX_YJS_UPDATE_SIZE_BYTES',
        PAGES_REALTIME_DEFAULTS.yjs.maxUpdateSizeBytes,
      ),
      maxDocumentSizeBytes: this.parseNum(
        'REALTIME_MAX_DOCUMENT_SIZE_BYTES',
        PAGES_REALTIME_DEFAULTS.yjs.maxDocumentSizeBytes,
      ),
      flushDebounceMs: this.parseNum(
        'PAGES_REALTIME_YJS_FLUSH_DEBOUNCE_MS',
        PAGES_REALTIME_DEFAULTS.yjs.flushDebounceMs,
      ),
      maxFlushDelayMs: this.parseNum(
        'PAGES_REALTIME_YJS_MAX_FLUSH_DELAY_MS',
        PAGES_REALTIME_DEFAULTS.yjs.maxFlushDelayMs,
      ),
      flushRetryDelayMs: this.parseNum(
        'PAGES_REALTIME_YJS_FLUSH_RETRY_MS',
        PAGES_REALTIME_DEFAULTS.yjs.flushRetryDelayMs,
      ),
      flushLockTtlMs: this.parseNum(
        'PAGES_REALTIME_YJS_FLUSH_LOCK_TTL_MS',
        PAGES_REALTIME_DEFAULTS.yjs.flushLockTtlMs,
      ),
      idleThresholdMs: this.parseNum(
        'PAGES_REALTIME_YJS_IDLE_THRESHOLD_MS',
        PAGES_REALTIME_DEFAULTS.yjs.idleThresholdMs,
      ),
      maxActiveDocs: this.parseNum(
        'PAGES_REALTIME_YJS_MAX_ACTIVE_DOCS',
        this.resourceGovernor?.getTierBudgets().realtimeMaxActiveDocs ??
          PAGES_REALTIME_DEFAULTS.yjs.maxActiveDocs,
      ),
      sweepIntervalMs: this.parseNum(
        'PAGES_REALTIME_YJS_SWEEP_INTERVAL_MS',
        PAGES_REALTIME_DEFAULTS.yjs.sweepIntervalMs,
      ),
      redisSnapshotTtlSeconds: this.parseNum(
        'PAGES_REALTIME_YJS_REDIS_TTL_SECONDS',
        PAGES_REALTIME_DEFAULTS.yjs.redisSnapshotTtlSeconds,
      ),
    };
  }

  public getAccessConfig(): PagesAccessConfig {
    return {
      cacheTtlSeconds: this.parseNum(
        'REALTIME_AUTH_CACHE_TTL_SECONDS',
        PAGES_REALTIME_DEFAULTS.access.cacheTtlSeconds,
      ),
      maxCacheEntries: this.parseNum(
        'PAGES_REALTIME_AUTH_CACHE_MAX_ENTRIES',
        this.resourceGovernor?.getTierBudgets().realtimeMaxCacheEntries ??
          PAGES_REALTIME_DEFAULTS.access.maxCacheEntries,
      ),
    };
  }

  public getPresenceConfig(): PagesPresenceConfig {
    return {
      cursorRedisThrottleMs: this.parseNum(
        'PAGES_REALTIME_CURSOR_REDIS_THROTTLE_MS',
        PAGES_REALTIME_DEFAULTS.presence.cursorRedisThrottleMs,
      ),
      sessionTtlSeconds: this.parseNum(
        'PAGES_REALTIME_PRESENCE_TTL_SECONDS',
        PAGES_REALTIME_DEFAULTS.presence.sessionTtlSeconds,
      ),
    };
  }

  public getSessionConfig(): PagesSessionConfig {
    return {
      backgroundRetryDelayMs: this.parseNum(
        'PAGES_REALTIME_SESSION_RETRY_MS',
        PAGES_REALTIME_DEFAULTS.session.backgroundRetryDelayMs,
      ),
    };
  }

  public getRateLimitBudgets(): PagesRateLimitBudgets {
    return {
      cursor: {
        budgetPerSec: this.parseNum(
          'REALTIME_RATE_CURSOR_BUDGET',
          PAGES_REALTIME_DEFAULTS.rateLimits.cursor.budgetPerSec,
        ),
        burst: this.parseNum(
          'REALTIME_RATE_CURSOR_BURST',
          PAGES_REALTIME_DEFAULTS.rateLimits.cursor.burst,
        ),
      },
      update: {
        budgetPerSec: this.parseNum(
          'REALTIME_RATE_UPDATE_BUDGET',
          PAGES_REALTIME_DEFAULTS.rateLimits.update.budgetPerSec,
        ),
        burst: this.parseNum(
          'REALTIME_RATE_UPDATE_BURST',
          PAGES_REALTIME_DEFAULTS.rateLimits.update.burst,
        ),
      },
      joinLeave: {
        budgetPerSec: this.parseNum(
          'REALTIME_RATE_JOIN_LEAVE_BUDGET',
          PAGES_REALTIME_DEFAULTS.rateLimits.joinLeave.budgetPerSec,
        ),
        burst: this.parseNum(
          'REALTIME_RATE_JOIN_LEAVE_BURST',
          PAGES_REALTIME_DEFAULTS.rateLimits.joinLeave.burst,
        ),
      },
    };
  }

  public getRateLimitPolicy(): WsRateLimitPolicy {
    return {
      classify: classifyPagesEvent,
      budgets: this.getRateLimitBudgets(),
      maxThrottledConsecutiveWindows:
        this.coreConfig?.getRateLimiterConfig()
          ?.maxThrottledConsecutiveWindows ??
        REALTIME_CORE_DEFAULTS.rateLimiter.maxThrottledConsecutiveWindows,
    };
  }

  private parseNum(key: string, fallback: number): number {
    return parsePositiveInt(this.config?.get<string | number>(key), fallback);
  }
}
