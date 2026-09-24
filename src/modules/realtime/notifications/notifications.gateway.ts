/**
 * realtime/gateways/notification.gateway.ts
 * Real-Time WebSocket Gateway for System Notifications, Mentions, and Global User Alerts.
 */

import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, Injectable, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(NotificationGateway.name);

  constructor(
    @Optional() private readonly jwtService?: JwtService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  public afterInit(server: Server): void {
    this.logger.log('Global Notifications WebSocket Gateway initialized (/notifications).');
  }

  public async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    let userId = (client.handshake.auth?.userId as string) || (client.handshake.query?.userId as string);

    if (token && this.jwtService) {
      try {
        const secret =
          this.configService?.get<string>('JWT_SECRET') || process.env.JWT_SECRET || 'secret';
        const payload = await this.jwtService.verifyAsync(token, { secret });
        userId = payload.sub || payload.id || userId;
      } catch (err: any) {
        this.logger.debug(`Socket ${client.id} notification handshake token invalid: ${err.message}`);
      }
    }

    if (!userId) {
      userId = `anon-${client.id.substring(0, 8)}`;
    }

    client.data = { userId };

    // Join personal user notification room
    const userRoom = `user:${userId}`;
    client.join(userRoom);
    this.logger.debug(`Client ${client.id} joined notification room: ${userRoom}`);
  }

  public handleDisconnect(client: Socket): void {
    const userId = client.data?.userId;
    if (userId) {
      client.leave(`user:${userId}`);
    }
  }

  /**
   * Broadcast a notification event directly to a specific user.
   */
  public sendToUser(userId: string, event: string, payload: any): void {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, payload);
    }
  }

  /**
   * Broadcast a system-wide announcement to all connected users.
   */
  public broadcastSystem(event: string, payload: any): void {
    if (this.server) {
      this.server.emit(event, payload);
    }
  }

  private extractToken(client: Socket): string | null {
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
}
