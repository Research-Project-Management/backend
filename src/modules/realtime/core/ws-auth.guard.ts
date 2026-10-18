import { Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';

export interface WsUserSession {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  authenticated: boolean;
}

@Injectable()
export class WsAuthService {
  private readonly logger = new Logger(WsAuthService.name);

  constructor(
    @Optional() private readonly jwtService?: JwtService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  public extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    const tokenAuth = client.handshake.auth?.token;
    if (tokenAuth && typeof tokenAuth === 'string') {
      return tokenAuth;
    }
    const queryToken = client.handshake.query?.token;
    if (queryToken && typeof queryToken === 'string') {
      return queryToken;
    }
    return null;
  }

  public async authenticateSocket(client: Socket): Promise<WsUserSession> {
    const token = this.extractToken(client);
    const configuredSecret =
      this.configService?.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
    let userId: string | undefined;
    let userName: string | undefined;
    let tokenRejected = false;

    if (token && this.jwtService) {
      try {
        const secret = configuredSecret || 'secret';
        const payload = (await this.jwtService.verifyAsync(token, {
          secret,
        })) as { sub?: string; id?: string; name?: string; email?: string };
        userId = payload.sub || payload.id;
        userName = payload.name || payload.email;
      } catch {
        tokenRejected = true;
        this.logger.debug(
          `Socket ${client.id} provided invalid JWT token; ignoring unverified handshake userId.`,
        );
      }
    }

    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const query = client.handshake.query as Record<string, unknown> | undefined;

    if (!userId && !tokenRejected) {
      const handshakeUserId =
        (typeof auth?.userId === 'string' ? auth.userId : undefined) ||
        (typeof query?.userId === 'string' ? query.userId : undefined);
      if (handshakeUserId && (!configuredSecret || !this.jwtService)) {
        userId = handshakeUserId;
      }
    }

    if (!userName) {
      userName =
        (typeof auth?.name === 'string' ? auth.name : undefined) ||
        (typeof query?.name === 'string' ? query.name : undefined);
    }

    if (!userId) {
      userId = `anon-${client.id.substring(0, 8)}`;
    }

    return {
      userId,
      name: userName || 'Collaborator',
      color: typeof auth?.color === 'string' ? auth.color : undefined,
      avatar: typeof auth?.avatar === 'string' ? auth.avatar : undefined,
      authenticated: !tokenRejected && !userId.startsWith('anon-'),
    };
  }
}
