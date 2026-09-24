/**
 * realtime/core/adapters/broadcast/socket-io-broadcaster.adapter.ts
 * Driven Adapter implementing IRealtimeBroadcasterPort using NestJS Socket.IO Server.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { IRealtimeBroadcasterPort } from '../../ports/realtime-broadcaster.port';

@Injectable()
export class SocketIoBroadcasterAdapter extends IRealtimeBroadcasterPort {
  private readonly logger = new Logger(SocketIoBroadcasterAdapter.name);
  private ioServer: Server | null = null;

  public setServer(server: Server): void {
    this.ioServer = server;
  }

  public getServer(): Server | null {
    return this.ioServer;
  }

  public broadcastToProject(
    projectId: string,
    event: string,
    payload: any,
    excludeSocketId?: string,
  ): void {
    if (!this.ioServer) {
      return;
    }
    const room = `project:${projectId}`;
    if (excludeSocketId) {
      this.ioServer.to(room).except(excludeSocketId).emit(event, payload);
    } else {
      this.ioServer.to(room).emit(event, payload);
    }
  }

  public broadcastToDoc(
    projectId: string,
    docId: string,
    event: string,
    payload: any,
    excludeSocketId?: string,
  ): void {
    if (!this.ioServer) {
      return;
    }
    const room = `doc:${projectId}:${docId}`;
    if (excludeSocketId) {
      this.ioServer.to(room).except(excludeSocketId).emit(event, payload);
    } else {
      this.ioServer.to(room).emit(event, payload);
    }
  }

  public sendToSocket(socketId: string, event: string, payload: any): void {
    if (!this.ioServer) {
      return;
    }
    this.ioServer.to(socketId).emit(event, payload);
  }
}
