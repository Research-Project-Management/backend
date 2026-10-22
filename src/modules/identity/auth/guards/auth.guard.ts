import * as crypto from 'crypto';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '@/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IDENTITY_REDIS_KEYS } from '../../core/constants/identity.constant';

/**
 * Enterprise Authentication Guard.
 * Validates JWT Bearer tokens, enforces real-time Redis token revocation,
 * and supports @Public() route bypass via Reflector.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    @Optional() private readonly redis?: RedisCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();

    if (isPublic) {
      await this.tryPopulateOptionalUser(request);
      return true;
    }

    // 1. Support Inter-Service Authentication (e.g. FLux-AI orchestrator tools)
    const internalKey = request.headers?.['x-internal-key'];
    const configuredInternalKey =
      this.configService.get<string>('INTERNAL_API_KEY') ||
      process.env.INTERNAL_API_KEY;

    if (internalKey) {
      if (!configuredInternalKey) {
        throw new UnauthorizedException(
          'Internal service key is not configured',
        );
      }
      const keyHash = crypto
        .createHash('sha256')
        .update(String(internalKey))
        .digest();
      const confHash = crypto
        .createHash('sha256')
        .update(String(configuredInternalKey))
        .digest();
      if (!crypto.timingSafeEqual(keyHash, confHash)) {
        throw new UnauthorizedException('Invalid internal service credentials');
      }

      // Internal service calls MUST provide a signed delegation token in x-delegation-token or Authorization header
      const delegationHeader = request.headers?.['x-delegation-token'];
      const authHeader = request.headers?.authorization;
      const token =
        (typeof delegationHeader === 'string' && delegationHeader.trim()
          ? delegationHeader.replace(/^Bearer\s+/i, '').trim()
          : null) ||
        (authHeader && authHeader.startsWith('Bearer ')
          ? authHeader.split(' ')[1]
          : null);

      if (!token) {
        throw new UnauthorizedException(
          'Internal service calls require a valid signed delegation token',
        );
      }

      try {
        const secret =
          this.configService.get<string>('JWT_SECRET') ||
          process.env.JWT_SECRET;
        if (!secret) {
          throw new UnauthorizedException('JWT secret is not configured');
        }
        const payload = await this.jwtService.verifyAsync(token, { secret });

        // Reject header spoofing: x-user-id MUST match payload subject
        const spoofedUserId = request.headers?.['x-user-id'];
        if (
          spoofedUserId &&
          spoofedUserId !== payload.sub &&
          spoofedUserId !== payload.id
        ) {
          throw new UnauthorizedException(
            'Spoofed user ID does not match delegation token subject',
          );
        }

        request.user = {
          ...payload,
          id: payload.sub || payload.id,
          sub: payload.sub || payload.id,
          isInternalService: true,
        };
        return true;
      } catch (err: unknown) {
        if (err instanceof UnauthorizedException) throw err;
        throw new UnauthorizedException(
          'Delegation token is invalid or expired',
        );
      }
    }

    const authHeader = request.headers?.authorization;
    let token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : null;

    // Security: Query parameter token is restricted to streaming/SSE endpoints and artifact downloads to prevent token leakage in access logs
    if (!token && request.query?.token) {
      const url = request.raw?.url || request.url || '';
      const isAllowedDownloadOrStreamPath =
        url.includes('/stream') ||
        url.includes('/events') ||
        url.includes('/sse') ||
        url.includes('/artifacts') ||
        url.includes('/storage/files/');
      if (isAllowedDownloadOrStreamPath) {
        token = String(request.query.token);
      }
    }

    if (!token) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    try {
      const secret =
        this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
      if (!secret) {
        throw new UnauthorizedException(
          'JWT authentication secret is not configured',
        );
      }
      const payload = await this.jwtService.verifyAsync(token, { secret });

      // Real-time Token Revocation check via Redis
      const userId = payload.sub || payload.id;
      const sessionId = payload.sid;

      if (this.redis) {
        try {
          if (sessionId) {
            const isSessionRevoked = await this.redis.get<string | number>(
              IDENTITY_REDIS_KEYS.revokedSession(sessionId),
            );
            if (isSessionRevoked) {
              throw new UnauthorizedException(
                'Session has been revoked or expired. Please log in again.',
              );
            }
          }

          if (userId) {
            const revokedAt = await this.redis.get<number>(
              IDENTITY_REDIS_KEYS.revoked(userId),
            );
            if (revokedAt) {
              const tokenIatMs = (payload.iat || 0) * 1000;
              if (tokenIatMs <= revokedAt) {
                throw new UnauthorizedException(
                  'Session has been revoked or expired. Please log in again.',
                );
              }
            }
          }
        } catch (err: unknown) {
          if (err instanceof UnauthorizedException) throw err;
          // Non-blocking if Redis is down/bypassed
        }
      }

      request.user = {
        ...payload,
        id: payload.id || payload.sub,
        sub: payload.sub || payload.id,
      };
      return true;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Token is invalid or expired');
    }
  }

  private async tryPopulateOptionalUser(request: {
    headers?: Record<string, string | undefined>;
    query?: Record<string, string | undefined>;
    raw?: { url?: string };
    url?: string;
    user?: Record<string, unknown>;
  }): Promise<void> {
    if (request.user?.id) return;
    const authHeader = request.headers?.authorization;
    let token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : null;

    if (!token && request.query?.token) {
      token = String(request.query.token);
    }

    if (!token) return;

    try {
      const secret =
        this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
      if (!secret) return;
      const payload = await this.jwtService.verifyAsync(token, { secret });
      const userId = payload.sub || payload.id;
      if (userId && this.redis) {
        const revokedAt = await this.redis
          .get<number>(IDENTITY_REDIS_KEYS.revoked(userId))
          .catch(() => null);
        if (revokedAt && (payload.iat || 0) * 1000 <= revokedAt) {
          return;
        }
      }
      request.user = {
        ...payload,
        id: payload.id || payload.sub,
        sub: payload.sub || payload.id,
      };
    } catch {
      // Ignore invalid token on @Public() route; downstream policy decides if anonymous access is permitted
    }
  }
}

// ─── Standard & Backward Compatibility Aliases ───────────────────────────────
export const JwtAuthGuard = AuthGuard;
export type JwtAuthGuard = AuthGuard;

