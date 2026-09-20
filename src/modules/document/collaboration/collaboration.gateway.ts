import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, Optional, Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { IDENTITY_REDIS_KEYS } from '@/modules/identity/identity.facade';
import { PROJECT_ACCESS_REDIS_KEYS } from '@/modules/project/access';
import { PageRepository } from '../page/page.repository';
import { CollaborationService } from './collaboration.service';
import { YjsDocumentManager } from './yjs-document.manager';

interface SocketMeta {
  pageId: string;
  userId: string;
  role: string;
  canWrite: boolean;
}

interface JoinDocumentPayload {
  pageId: string;
  projectId?: string;
  user?: {
    id?: string;
    name?: string;
    avatar?: string;
    role?: string;
  };
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/collaboration',
})
export class CollaborationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(CollaborationGateway.name);
  private readonly socketToUser = new Map<string, SocketMeta>();

  constructor(
    private readonly collaborationService: CollaborationService,
    private readonly yjsDocumentManager: YjsDocumentManager,
    private readonly pageRepository: PageRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Overleaf-grade Connection Authentication Guard:
   * Validates JWT Bearer token from handshake auth or headers,
   * checks real-time Redis token revocation, and rejects unauthenticated sockets.
   */
  async handleConnection(client: Socket) {
    if (process.env.STANDALONE_LIBRARY === 'true') {
      const defaultUserId = '3f3fb23b-2193-4763-84e5-c934a10b3cd9';
      client.data.user = {
        id: defaultUserId,
        sub: defaultUserId,
        name: 'Sandbox Tester',
        email: 'tester@flux.local',
      };
      this.logger.debug(`[WebSocket] Standalone connection: ${client.id}`);
      return;
    }

    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(
        `[WebSocket] Rejected unauthenticated connection: ${client.id} (missing token)`,
      );
      client.emit('auth_error', {
        message: 'Authentication required: missing token',
      });
      client.disconnect(true);
      return;
    }

    try {
      const secret =
        this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
      if (!secret) {
        this.logger.error('[WebSocket] JWT secret is not configured');
        client.disconnect(true);
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, { secret });
      const userId = payload.sub || payload.id;

      if (!userId) {
        this.logger.warn(
          `[WebSocket] Token payload missing user ID for ${client.id}`,
        );
        client.disconnect(true);
        return;
      }

      // Check real-time token revocation in Redis
      if (this.redis) {
        try {
          const revokedAt = await this.redis.get<number>(
            IDENTITY_REDIS_KEYS.revoked(userId),
          );
          if (revokedAt) {
            const tokenIatMs = (payload.iat || 0) * 1000;
            if (tokenIatMs <= revokedAt) {
              this.logger.warn(`[WebSocket] Token revoked for user ${userId}`);
              client.emit('auth_error', {
                message: 'Session has been revoked. Please log in again.',
              });
              client.disconnect(true);
              return;
            }
          }
        } catch {
          // Non-blocking if Redis is down
        }
      }

      client.data.user = {
        id: userId,
        email: payload.email,
        name: payload.name || payload.email || 'Researcher',
      };

      this.logger.debug(
        `[WebSocket] Authenticated client connected: ${client.id} (user: ${userId})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `[WebSocket] Invalid token for client ${client.id}: ${err?.message || err}`,
      );
      client.emit('auth_error', { message: 'Invalid or expired token' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const meta = this.socketToUser.get(client.id);
    if (meta) {
      const { pageId, userId } = meta;
      this.socketToUser.delete(client.id);

      this.yjsDocumentManager.handleClientLeave(pageId);

      const remainingUsers = await this.collaborationService.leaveRoom(
        pageId,
        userId,
      );
      this.server.to(`doc:${pageId}`).emit('user_left', {
        userId,
        activeUsers: remainingUsers,
        timestamp: Date.now(),
      });
      this.logger.debug(
        `[WebSocket] Client ${client.id} (user: ${userId}) disconnected from doc:${pageId}`,
      );
    }
  }

  /**
   * Room Authorization & Role Gating:
   * Validates project membership, assigns Read-Write vs Read-Only capabilities.
   */
  @SubscribeMessage('join_document')
  async handleJoinDocument(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinDocumentPayload,
  ) {
    if (!payload?.pageId) {
      return { status: 'error', message: 'Missing pageId' };
    }

    const authUser = client.data?.user;
    if (!authUser) {
      client.disconnect(true);
      return { status: 'error', message: 'Unauthorized socket' };
    }

    const { pageId } = payload;
    const room = `doc:${pageId}`;

    // Anti-spoofing check
    if (payload.user?.id && payload.user.id !== authUser.id) {
      this.logger.warn(
        `[WebSocket] Anti-spoofing triggered: payload user ${payload.user.id} does not match token subject ${authUser.id}`,
      );
      return {
        status: 'error',
        message: 'User ID does not match authenticated token',
      };
    }

    // 1. Resolve page & project context
    let page: any = null;
    try {
      page = await this.pageRepository.findPageById(pageId);
    } catch (err: any) {
      this.logger.error(
        `Error resolving page ${pageId}: ${err?.message || err}`,
      );
    }

    if (!page) {
      return { status: 'error', message: 'Page not found' };
    }

    const projectId = page.projectId;

    // 2. Resolve user's project role & permission
    let role = 'REVIEWER';
    let canWrite = false;

    if (process.env.STANDALONE_LIBRARY === 'true') {
      role = 'OWNER';
      canWrite = true;
    } else {
      const projectRole = await this.resolveProjectRole(projectId, authUser.id);
      if (!projectRole) {
        return {
          status: 'forbidden',
          message: 'Access denied: You are not a member of this project',
        };
      }
      role = projectRole;
      const upperRole = role.toUpperCase();
      canWrite = ['OWNER', 'COORDINATOR', 'CONTRIBUTOR'].includes(upperRole);
    }

    // Clean up previous room if this socket was attached to another document
    const previousMeta = this.socketToUser.get(client.id);
    if (previousMeta && previousMeta.pageId !== pageId) {
      const oldRoom = `doc:${previousMeta.pageId}`;
      await client.leave(oldRoom);
      this.yjsDocumentManager.handleClientLeave(previousMeta.pageId);
      const remainingUsers = await this.collaborationService.leaveRoom(
        previousMeta.pageId,
        previousMeta.userId,
      );
      this.server.to(oldRoom).emit('user_left', {
        userId: previousMeta.userId,
        activeUsers: remainingUsers,
        timestamp: Date.now(),
      });
    }

    await client.join(room);
    this.socketToUser.set(client.id, {
      pageId,
      userId: authUser.id,
      role,
      canWrite,
    });

    // Initialize/retrieve active Y.Doc session
    await this.yjsDocumentManager.getOrCreateDoc(pageId);

    const activeUsers = await this.collaborationService.updatePresence(pageId, {
      id: authUser.id,
      name: authUser.name || payload.user?.name || 'Researcher',
      avatar: payload.user?.avatar,
      role,
    });

    // Notify room of joined user
    client.to(room).emit('user_joined', {
      user: activeUsers.find((u) => u.id === authUser.id),
      activeUsers,
      timestamp: Date.now(),
    });

    return {
      status: 'ok',
      activeUsers,
      canWrite,
      role,
    };
  }

  @SubscribeMessage('leave_document')
  async handleLeaveDocument(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; userId?: string },
  ) {
    if (!payload?.pageId) return;

    const { pageId } = payload;
    const meta = this.socketToUser.get(client.id);
    const userId = meta?.userId || client.data?.user?.id || payload.userId;
    if (!userId) return;

    const room = `doc:${pageId}`;
    await client.leave(room);
    this.socketToUser.delete(client.id);

    this.yjsDocumentManager.handleClientLeave(pageId);

    const activeUsers = await this.collaborationService.leaveRoom(
      pageId,
      userId,
    );
    this.server.to(room).emit('user_left', {
      userId,
      activeUsers,
      timestamp: Date.now(),
    });

    return { status: 'ok' };
  }

  @SubscribeMessage('lock_state')
  async handleLockState(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { pageId: string; isLocked: boolean },
  ) {
    if (!payload?.pageId) {
      return { status: 'error', message: 'Missing pageId' };
    }

    const meta = this.socketToUser.get(client.id);
    if (!meta || meta.pageId !== payload.pageId) {
      return {
        status: 'error',
        message: 'Unauthorized: Socket is not active in this document room',
      };
    }

    if (!meta.canWrite) {
      return {
        status: 'error',
        message:
          'Permission denied: Read-only users cannot lock or unlock pages',
      };
    }

    const effectiveLockedBy = meta.userId;
    const room = `doc:${payload.pageId}`;
    await this.collaborationService.broadcastLockChange(
      payload.pageId,
      payload.isLocked,
      effectiveLockedBy,
    );
    this.server.to(room).emit('lock_updated', {
      isLocked: payload.isLocked,
      lockedBy: effectiveLockedBy,
      timestamp: Date.now(),
    });

    return {
      status: 'ok',
      isLocked: payload.isLocked,
      lockedBy: effectiveLockedBy,
    };
  }

  // --------------------------------------------------------------------------
  // Yjs CRDT Synchronization Protocol (Overleaf Collaborative Engine)
  // --------------------------------------------------------------------------

  @SubscribeMessage('yjs:sync-step-1')
  async handleYjsSyncStep1(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; stateVector?: any },
  ) {
    const { pageId, stateVector } = payload || {};
    if (!pageId) return;

    await this.yjsDocumentManager.getOrCreateDoc(pageId);

    const clientSv = stateVector ? new Uint8Array(stateVector) : undefined;
    const update = this.yjsDocumentManager.encodeStateAsUpdate(
      pageId,
      clientSv,
    );

    if (update && update.length > 0) {
      client.emit('yjs:sync-step-2', {
        pageId,
        update: Buffer.from(update),
      });
    }

    const serverSv = this.yjsDocumentManager.getStateVector(pageId);
    if (serverSv) {
      client.emit('yjs:sync-step-1', {
        pageId,
        stateVector: Buffer.from(serverSv),
      });
    }
  }

  @SubscribeMessage('yjs:sync-step-2')
  handleYjsSyncStep2(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; update: any },
  ) {
    const { pageId, update } = payload || {};
    if (!pageId || !update) return;

    const meta = this.socketToUser.get(client.id);
    if (!meta || meta.pageId !== pageId) return;

    if (!meta.canWrite) {
      this.logger.warn(
        `[Yjs] Read-only user ${meta.userId} (${meta.role}) attempted yjs:sync-step-2 on page ${pageId}`,
      );
      client.emit('yjs:error', {
        message: 'Permission denied: Read-only access',
      });
      return;
    }

    const u = new Uint8Array(update);
    this.yjsDocumentManager.applyUpdate(pageId, u, meta.userId);

    client.to(`doc:${pageId}`).emit('yjs:update', {
      pageId,
      update: Buffer.from(u),
    });
  }

  @SubscribeMessage('yjs:update')
  handleYjsUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; update: any },
  ) {
    const { pageId, update } = payload || {};
    if (!pageId || !update) return;

    const meta = this.socketToUser.get(client.id);
    if (!meta || meta.pageId !== pageId) return;

    if (!meta.canWrite) {
      this.logger.warn(
        `[Yjs] Read-only user ${meta.userId} (${meta.role}) attempted yjs:update on page ${pageId}`,
      );
      client.emit('yjs:error', {
        message: 'Permission denied: Read-only access',
      });
      return;
    }

    const u = new Uint8Array(update);
    this.yjsDocumentManager.applyUpdate(pageId, u, meta.userId);

    // Broadcast update to all other collaborators in the room
    client.to(`doc:${pageId}`).emit('yjs:update', {
      pageId,
      update: Buffer.from(u),
    });
  }

  @SubscribeMessage('yjs:awareness')
  handleYjsAwareness(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; awarenessUpdate: any },
  ) {
    const { pageId, awarenessUpdate } = payload || {};
    if (!pageId || !awarenessUpdate) return;

    client.to(`doc:${pageId}`).emit('yjs:awareness', {
      pageId,
      awarenessUpdate: Buffer.from(new Uint8Array(awarenessUpdate)),
    });
  }

  @SubscribeMessage('yjs:checkpoint')
  async handleYjsCheckpoint(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pageId: string; label?: string },
  ) {
    const meta = this.socketToUser.get(client.id);
    if (!meta || meta.pageId !== payload?.pageId) return;

    if (!meta.canWrite) {
      return {
        status: 'error',
        message: 'Permission denied: Read-only users cannot create checkpoints',
      };
    }

    await this.yjsDocumentManager.createCollaborativeCheckpoint(
      payload.pageId,
      meta.userId,
      payload.label,
    );
    return { status: 'ok' };
  }

  /**
   * Helper: Extract Bearer token from handshake auth, headers, or query.
   */
  private extractToken(client: Socket): string | null {
    if (client.handshake?.auth?.token) {
      const token = String(client.handshake.auth.token);
      return token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
    }
    const authHeader = client.handshake?.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    if (client.handshake?.query?.token) {
      return String(client.handshake.query.token).trim();
    }
    return null;
  }

  /**
   * Helper: Resolves project role for a user with Redis caching.
   */
  private async resolveProjectRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const cacheKey = PROJECT_ACCESS_REDIS_KEYS.role(projectId, userId);
    if (this.redis) {
      try {
        const cached = await this.redis.get<string>(cacheKey);
        if (cached) return cached;
      } catch {
        // Fallback to database
      }
    }

    if (!this.prisma) return null;
    const prismaAny = this.prisma as any;

    try {
      if (prismaAny.project) {
        const project = await prismaAny.project.findFirst({
          where: { id: projectId, deletedAt: null },
          select: { id: true, createdById: true },
        });
        if (project && project.createdById === userId) {
          if (this.redis) {
            await this.redis.set(cacheKey, 'OWNER', 600).catch(() => {});
          }
          return 'OWNER';
        }
      }

      if (prismaAny.projectMember) {
        const member = await prismaAny.projectMember.findUnique({
          where: {
            projectId_userId: { projectId, userId },
          },
          select: { role: true },
        });
        if (member && member.role) {
          if (this.redis) {
            await this.redis
              .set(cacheKey, String(member.role), 600)
              .catch(() => {});
          }
          return String(member.role);
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to resolve project role for user ${userId} in ${projectId}: ${err?.message || err}`,
      );
    }

    return null;
  }

  /**
   * Broadcasts a binary Yjs update directly to all connected clients in a document room.
   * Useful for server-initiated state modifications like Version Restore.
   */
  broadcastYjsUpdate(pageId: string, update: Uint8Array): void {
    if (!this.server) return;
    this.server.to(`doc:${pageId}`).emit('yjs:update', {
      pageId,
      update: Buffer.from(update),
    });
    this.logger.debug(
      `[Yjs] Broadcasted server update to room doc:${pageId} (${update.byteLength} bytes)`,
    );
  }

  /**
   * Broadcasts a domain event to all clients in a document room.
   * Used for real-time collaboration events like comment:created, suggestion:accepted, etc.
   */
  broadcastRoomEvent(pageId: string, event: string, payload: any): void {
    if (!this.server) return;
    this.server.to(`doc:${pageId}`).emit(event, payload);
    this.logger.debug(`[WebSocket] Broadcasted ${event} to room doc:${pageId}`);
  }
}
