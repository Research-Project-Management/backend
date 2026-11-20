import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { IdentityFacade } from '@/modules/identity/identity.facade';
import { RealtimeConfigService } from './config';
import { RealtimeAuthRequiredException } from './errors';

export interface WsUserSession {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  authenticated: boolean;
}

export type SocketIOMiddleware = (
  socket: Socket,
  next: (err?: Error) => void,
) => void | Promise<void>;

@Injectable()
export class WsAuthService implements OnModuleInit {
  private readonly logger = new Logger(WsAuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: RealtimeConfigService,
    @Optional() private readonly identityFacade?: IdentityFacade,
  ) {}

  public onModuleInit(): void {
    // Fail-fast on startup if signing secret is absent or empty
    this.configService.getJwtSecret();
  }

  /**
   * Extracts token strictly from the Authorization Bearer header or the handshake auth.token payload.
   * Query string tokens are rejected to prevent credential leaks in logs.
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
    return null;
  }

  /**
   * Authenticates a WebSocket handshake.
   * Rejects missing, invalid, or expired credentials without fallback or anonymous sessions.
   */
  public async authenticateSocket(client: Socket): Promise<WsUserSession> {
    const token = this.extractToken(client);
    if (!token) {
      throw new RealtimeAuthRequiredException('Authentication required');
    }

    const secret = this.configService.getJwtSecret();
    let payload: Record<string, unknown>;
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

    const rawName = payload.name || payload.email;
    let userName =
      typeof rawName === 'string' && rawName ? rawName : 'Collaborator';
    let userAvatar: string | undefined =
      typeof payload.avatar === 'string' && payload.avatar
        ? payload.avatar
        : undefined;

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

/**
 * Socket.IO Namespace Middleware.
 * Authenticates the connection before the socket is admitted and attaches WsUserSession.
 */
export function createWsConnectionMiddleware(
  authService: WsAuthService,
): SocketIOMiddleware {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    try {
      const session = await authService.authenticateSocket(socket);
      if (!session || !session.authenticated) {
        return next(
          new RealtimeAuthRequiredException('Authentication required'),
        );
      }

      socket.data = {
        ...((socket.data as Record<string, unknown> | undefined) ?? {}),
        ...session,
      };

      next();
    } catch (err: unknown) {
      if (err instanceof Error) {
        return next(err);
      }
      return next(new RealtimeAuthRequiredException());
    }
  };
}
