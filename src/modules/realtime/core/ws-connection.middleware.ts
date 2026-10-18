import { Socket } from 'socket.io';
import { WsAuthService } from './ws-auth.guard';
import { RealtimeAuthRequiredException } from './ws-errors';

export type SocketIOMiddleware = (
  socket: Socket,
  next: (err?: Error) => void,
) => void | Promise<void>;

/**
 * Socket.IO Namespace Middleware
 * Authenticates the connection before the socket is admitted.
 * Refuses unauthenticated or invalid connections at the handshake layer (R-01).
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
        ...socket.data,
        ...session,
        projectId: null,
        activeDocId: null,
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
