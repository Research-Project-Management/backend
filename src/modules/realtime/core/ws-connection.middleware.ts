import { Socket } from 'socket.io';
import { WsAuthService } from './ws-auth.service';
import { RealtimeAuthRequiredException } from './ws-errors';

export type SocketIOMiddleware = (
  socket: Socket,
  next: (err?: Error) => void,
) => void | Promise<void>;

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
