import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RateLimitBucket =
  'compile' | 'import' | 'upload' | 'linked-file' | 'search-replace' | 'git';

export interface RateLimitBudget {
  limit: number;
  windowSeconds: number;
}

export const DEFAULT_RATE_LIMIT_BUDGETS: Record<
  RateLimitBucket,
  RateLimitBudget
> = {
  compile: { limit: 10, windowSeconds: 60 },
  import: { limit: 5, windowSeconds: 60 },
  upload: { limit: 30, windowSeconds: 60 },
  'linked-file': { limit: 10, windowSeconds: 60 },
  'search-replace': { limit: 20, windowSeconds: 60 },
  git: { limit: 60, windowSeconds: 60 },
};

@Injectable()
export class RateLimitConfigService {
  constructor(private readonly configService?: ConfigService) {}

  public isEnabled(): boolean {
    const raw =
      this.configService?.get<string>('RATE_LIMIT_ENABLED') ??
      process.env.RATE_LIMIT_ENABLED;
    if (raw === undefined || raw === null || raw === '') return true;
    return raw.toLowerCase() !== 'false' && raw !== '0';
  }

  public getBudget(bucket: RateLimitBucket): RateLimitBudget {
    const defaultBudget = DEFAULT_RATE_LIMIT_BUDGETS[bucket] || {
      limit: 60,
      windowSeconds: 60,
    };

    const envPrefix = `RATE_LIMIT_${bucket.toUpperCase().replace(/-/g, '_')}`;
    const envLimit =
      this.configService?.get<string | number>(`${envPrefix}_LIMIT`) ??
      process.env[`${envPrefix}_LIMIT`];
    const envWindow =
      this.configService?.get<string | number>(`${envPrefix}_WINDOW`) ??
      process.env[`${envPrefix}_WINDOW`] ??
      this.configService?.get<string | number>('RATE_LIMIT_DEFAULT_WINDOW') ??
      process.env.RATE_LIMIT_DEFAULT_WINDOW;

    const limit =
      envLimit !== undefined && envLimit !== ''
        ? Number(envLimit)
        : defaultBudget.limit;
    const windowSeconds =
      envWindow !== undefined && envWindow !== ''
        ? Number(envWindow)
        : defaultBudget.windowSeconds;

    return {
      limit: isNaN(limit) || limit <= 0 ? defaultBudget.limit : limit,
      windowSeconds:
        isNaN(windowSeconds) || windowSeconds <= 0
          ? defaultBudget.windowSeconds
          : windowSeconds,
    };
  }
}
