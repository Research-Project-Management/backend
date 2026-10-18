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
import { REALTIME_NAMESPACES } from '../core/realtime.constant';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: true,
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

  public afterInit(_server: Server): void {
    this.logger.log('Global Notifications WebSocket Gateway initialized (/notifications).');
  }

  public async handleConnection(client: Socket): Promise<void> {
    const session = await this.authService.authenticateSocket(client);
    client.data = session;

    const userRoom = `user:${session.userId}`;
    await client.join(userRoom);
    this.logger.debug(`Client ${client.id} joined notification room: ${userRoom}`);
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
