import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isOriginAllowed } from '@/core/http/setup/allowed-origins';

export const REALTIME_NAMESPACES = {
  PAGES: '/pages',
  CHAT: '/chat',
  WORK_ITEMS: '/work-items',
} as const;

export type RealtimeNamespace =
  (typeof REALTIME_NAMESPACES)[keyof typeof REALTIME_NAMESPACES];

export interface WsCorsOptions {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => void;
  credentials: boolean;
}

export function createWsCorsOptions(): WsCorsOptions {
  return {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
  };
}

export interface RateLimitBudget {
  budgetPerSec: number;
  burst: number;
}

export interface RealtimeTransportConfig {
  path: string;
  transports: Array<'websocket' | 'polling'>;
  maxMessageSizeBytes: number;
  pingTimeoutMs: number;
  pingIntervalMs: number;
  connectTimeoutMs: number;
}

export interface WsRateLimiterConfig {
  maxThrottledConsecutiveWindows: number;
  maxTrackedSockets: number;
  staleSocketTtlMs: number;
}

export const REALTIME_CORE_DEFAULTS = {
  transport: {
    path: '/socket.io/',
    transports: ['websocket', 'polling'] as Array<'websocket' | 'polling'>,
    maxMessageSizeBytes: 1024 * 1024, // 1 MiB
    pingTimeoutMs: 60_000,
    pingIntervalMs: 25_000,
    connectTimeoutMs: 45_000,
  },
  rateLimiter: {
    maxThrottledConsecutiveWindows: 5,
    maxTrackedSockets: 5_000,
    staleSocketTtlMs: 300_000,
  },
} as const;

export function parsePositiveInt(
  raw: string | number | undefined,
  fallback: number,
): number {
  const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class RealtimeConfigService {
  constructor(@Optional() private readonly config?: ConfigService) {}

  public getJwtSecret(): string {
    const secret = this.config?.get<string>('JWT_SECRET')?.trim();
    if (!secret) {
      throw new Error(
        'Realtime authentication misconfigured: JWT_SECRET must be set and non-empty. Default secret fallbacks are forbidden.',
      );
    }
    return secret;
  }

  public getMaxMessageSizeBytes(): number {
    return parsePositiveInt(
      this.config?.get<string | number>('REALTIME_MAX_MESSAGE_SIZE_BYTES'),
      REALTIME_CORE_DEFAULTS.transport.maxMessageSizeBytes,
    );
  }

  public getTransportConfig(): RealtimeTransportConfig {
    return {
      path: REALTIME_CORE_DEFAULTS.transport.path,
      transports: [...REALTIME_CORE_DEFAULTS.transport.transports],
      maxMessageSizeBytes: this.getMaxMessageSizeBytes(),
      pingTimeoutMs: this.parseNum(
        'REALTIME_PING_TIMEOUT_MS',
        REALTIME_CORE_DEFAULTS.transport.pingTimeoutMs,
      ),
      pingIntervalMs: this.parseNum(
        'REALTIME_PING_INTERVAL_MS',
        REALTIME_CORE_DEFAULTS.transport.pingIntervalMs,
      ),
      connectTimeoutMs: this.parseNum(
        'REALTIME_CONNECT_TIMEOUT_MS',
        REALTIME_CORE_DEFAULTS.transport.connectTimeoutMs,
      ),
    };
  }

  public getRateLimiterConfig(): WsRateLimiterConfig {
    return {
      maxThrottledConsecutiveWindows: this.parseNum(
        'REALTIME_RATE_MAX_THROTTLED_WINDOWS',
        REALTIME_CORE_DEFAULTS.rateLimiter.maxThrottledConsecutiveWindows,
      ),
      maxTrackedSockets: this.parseNum(
        'REALTIME_RATE_MAX_SOCKETS',
        REALTIME_CORE_DEFAULTS.rateLimiter.maxTrackedSockets,
      ),
      staleSocketTtlMs: this.parseNum(
        'REALTIME_RATE_STALE_SOCKET_MS',
        REALTIME_CORE_DEFAULTS.rateLimiter.staleSocketTtlMs,
      ),
    };
  }

  private parseNum(key: string, fallback: number): number {
    return parsePositiveInt(this.config?.get<string | number>(key), fallback);
  }
}
