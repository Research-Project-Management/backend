import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const url = request.raw?.url || request.url || '';

    // Allow public access to streamed R2 files (avatars, images, PDF streams)
    if (url.includes('/api/files/r2/')) {
      return true;
    }

    const authHeader = request.headers?.authorization;
    let token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : null;

    if (!token) {
      token =
        request.query?.token ||
        request.cookies?.token ||
        request.cookies?.accessToken ||
        null;
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
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Token is invalid or expired');
    }
  }
}
