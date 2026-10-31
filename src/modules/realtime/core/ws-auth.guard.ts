import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { IdentityFacade } from '@/modules/identity/identity.facade';
import { RealtimeConfigService } from './realtime.config';
import { RealtimeAuthRequiredException } from './ws-errors';

export interface WsUserSession {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  authenticated: boolean;
}

@Injectable()
export class WsAuthService implements OnModuleInit {
  private readonly logger = new Logger(WsAuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: RealtimeConfigService,
    @Optional() private readonly identityFacade?: IdentityFacade,
  ) {}

  public onModuleInit(): void {
    // Fail-fast on startup if signing secret is absent or empty (FR-002)
    this.configService.getJwtSecret();
  }

  /**
   * Extracts token strictly from the Authorization Bearer header or the handshake auth.token payload.
   * Query string tokens are rejected to prevent credential leaks in logs (FR-003).
   */
  public extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    const tokenAuth = client.handshake.auth?.token;
    if (tokenAuth && typeof tokenAuth === 'string') {
      return tokenAuth.trim();
    }
    // Query tokens are strictly rejected
    return null;
  }

  /**
   * Authenticates a WebSocket handshake.
   * Rejects missing, invalid, or expired credentials without fallback or anonymous sessions (FR-001, FR-004).
   */
  public async authenticateSocket(client: Socket): Promise<WsUserSession> {
    const token = this.extractToken(client);
    if (!token) {
      throw new RealtimeAuthRequiredException('Authentication required');
    }

    const secret = this.configService.getJwtSecret();
    let payload: Record<string, any>;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret,
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Socket ${client.id} failed JWT verification: ${(err as Error)?.message}`,
      );
      throw new RealtimeAuthRequiredException('Authentication required');
    }

    const userId = payload.sub || payload.id;
    if (!userId || typeof userId !== 'string') {
      throw new RealtimeAuthRequiredException(
        'Authentication required: invalid token subject',
      );
    }

    let userName = payload.name || payload.email || 'Collaborator';
    let userAvatar: string | undefined = payload.avatar || undefined;

    if (this.identityFacade) {
      const activeUser = await this.identityFacade
        .validateUser(userId)
        .catch(() => null);
      if (!activeUser) {
        throw new RealtimeAuthRequiredException(
          'Authentication required: user is inactive or suspended',
        );
      }
      userName = activeUser.name || userName;
      userAvatar = activeUser.avatar ?? userAvatar;
    }

    return {
      userId,
      name: userName,
      ...(userAvatar ? { avatar: userAvatar } : {}),
      authenticated: true,
    };
  }
}
