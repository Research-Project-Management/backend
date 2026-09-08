import * as crypto from 'crypto';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Enterprise JWT Authentication Guard.
 * Validates JWT Bearer tokens and supports @Public() route bypass via Reflector.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

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

      // Internal service calls MUST provide a signed delegation token in Authorization header
      const authHeader = request.headers?.authorization;
      const token =
        authHeader && authHeader.startsWith('Bearer ')
          ? authHeader.split(' ')[1]
          : null;

      if (!token) {
        throw new UnauthorizedException(
          'Internal service calls require a signed delegation token',
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
      } catch (err: any) {
        if (err instanceof UnauthorizedException) throw err;
        throw new UnauthorizedException(
          'Delegation token is invalid or expired',
        );
      }
    }

    const authHeader = request.headers?.authorization;
    const token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : null;

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
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Token is invalid or expired');
    }
  }
}
