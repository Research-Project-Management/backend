import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthService } from '../core/ws-auth.guard';
import { createWsConnectionMiddleware } from '../core/ws-connection.middleware';
import { REALTIME_NAMESPACES } from '../core/realtime.constant';
import { isOriginAllowed } from '@/core/http/setup/allowed-origins';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
  },
  namespace: REALTIME_NAMESPACES.NOTIFICATIONS,
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(NotificationGateway.name);

  constructor(private readonly authService: WsAuthService) {}

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
    this.logger.log(
      'Global Notifications WebSocket Gateway initialized (/notifications).',
    );
  }

  public async handleConnection(client: Socket): Promise<void> {
    try {
      if (!client.data?.authenticated) {
        const session = await this.authService.authenticateSocket(client);
        client.data = session;
      }

      const userRoom = `user:${client.data.userId}`;
      await client.join(userRoom);
      this.logger.debug(
        `Client ${client.id} joined notification room: ${userRoom}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Unauthorized notification socket connection on ${client.id}: ${(err as Error)?.message}`,
      );
      client.disconnect(true);
    }
  }

  public handleDisconnect(client: Socket): void {
    const userId = client.data?.userId;
    if (userId) {
      client.leave(`user:${userId}`);
    }
  }

  public sendToUser(userId: string, event: string, payload: unknown): void {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, payload);
    }
  }

  public broadcastSystem(event: string, payload: unknown): void {
    if (this.server) {
      this.server.emit(event, payload);
    }
  }
}
