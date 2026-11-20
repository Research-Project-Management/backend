import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const REALTIME_INTERNAL_KEY_HEADER = 'x-internal-key' as const;

const INTERNAL_KEY_DERIVATION_CONTEXT = 'flux:realtime:internal';

export function resolveRealtimeInternalKey(config?: ConfigService): string {
  const configured = (
    config?.get<string>('REALTIME_INTERNAL_API_KEY') ??
    process.env.REALTIME_INTERNAL_API_KEY ??
    ''
  ).trim();
  if (configured) {
    return configured;
  }

  const jwtSecret = (
    config?.get<string>('JWT_SECRET') ??
    process.env.JWT_SECRET ??
    ''
  ).trim();
  if (jwtSecret) {
    return createHmac('sha256', jwtSecret)
      .update(INTERNAL_KEY_DERIVATION_CONTEXT)
      .digest('hex');
  }

  return '';
}

@Injectable()
export class RealtimeInternalAuthGuard implements CanActivate {
  constructor(@Optional() private readonly config?: ConfigService) {}

  public canActivate(context: ExecutionContext): boolean {
    const expectedKey = resolveRealtimeInternalKey(this.config);
    const nodeEnv =
      this.config?.get<string>('NODE_ENV') ?? process.env.NODE_ENV;

    if (!expectedKey) {
      if (nodeEnv === 'production') {
        throw new UnauthorizedException(
          'Realtime internal API key is not configured',
        );
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const rawHeader = req?.headers?.[REALTIME_INTERNAL_KEY_HEADER];
    const provided = (
      Array.isArray(rawHeader) ? (rawHeader[0] ?? '') : (rawHeader ?? '')
    ).trim();

    if (!provided) {
      throw new UnauthorizedException('Invalid internal API key');
    }

    const expectedBuf = Buffer.from(expectedKey, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (
      expectedBuf.byteLength !== providedBuf.byteLength ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new UnauthorizedException('Invalid internal API key');
    }

    return true;
  }
}
