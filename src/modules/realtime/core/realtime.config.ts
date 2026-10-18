import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RateLimitBudget {
  budgetPerSec: number;
  burst: number;
}

export interface RealtimeRateLimitConfig {
  cursor: RateLimitBudget;
  update: RateLimitBudget;
  chat: RateLimitBudget;
  joinLeave: RateLimitBudget;
  maxThrottledConsecutiveWindows: number;
}

@Injectable()
export class RealtimeConfigService {
  constructor(private readonly config: ConfigService) {}

  public getJwtSecret(): string {
    const secret = this.config.get<string>('JWT_SECRET')?.trim();
    if (!secret) {
      throw new Error(
        'Realtime authentication misconfigured: JWT_SECRET must be set and non-empty. Default secret fallbacks are forbidden.',
      );
    }
    return secret;
  }

  public getMaxMessageSizeBytes(): number {
    const raw = this.config.get<string | number>(
      'REALTIME_MAX_MESSAGE_SIZE_BYTES',
    );
    const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024 * 1024; // 1 MiB
  }

  public getMaxYjsUpdateSizeBytes(): number {
    const raw = this.config.get<string | number>(
      'REALTIME_MAX_YJS_UPDATE_SIZE_BYTES',
    );
    const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 512 * 1024; // 512 KiB
  }

  public getMaxDocumentSizeBytes(): number {
    const raw = this.config.get<string | number>(
      'REALTIME_MAX_DOCUMENT_SIZE_BYTES',
    );
    const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20 * 1024 * 1024; // 20 MiB
  }

  public getAuthCacheTtlSeconds(): number {
    const raw = this.config.get<string | number>(
      'REALTIME_AUTH_CACHE_TTL_SECONDS',
    );
    const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30; // 30 seconds
  }

  public getRateLimits(): RealtimeRateLimitConfig {
    return {
      cursor: {
        budgetPerSec: this.parseNum('REALTIME_RATE_CURSOR_BUDGET', 20),
        burst: this.parseNum('REALTIME_RATE_CURSOR_BURST', 40),
      },
      update: {
        budgetPerSec: this.parseNum('REALTIME_RATE_UPDATE_BUDGET', 50),
        burst: this.parseNum('REALTIME_RATE_UPDATE_BURST', 100),
      },
      chat: {
        budgetPerSec: this.parseNum('REALTIME_RATE_CHAT_BUDGET', 5),
        burst: this.parseNum('REALTIME_RATE_CHAT_BURST', 10),
      },
      joinLeave: {
        budgetPerSec: this.parseNum('REALTIME_RATE_JOIN_LEAVE_BUDGET', 5),
        burst: this.parseNum('REALTIME_RATE_JOIN_LEAVE_BURST', 10),
      },
      maxThrottledConsecutiveWindows: this.parseNum(
        'REALTIME_RATE_MAX_THROTTLED_WINDOWS',
        5,
      ),
    };
  }

  private parseNum(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
