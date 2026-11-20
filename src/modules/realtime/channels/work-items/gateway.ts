import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import {
  WsAuthService,
  createWsConnectionMiddleware,
  type WsUserSession,
} from '../../core/auth';
import { REALTIME_NAMESPACES, createWsCorsOptions } from '../../core/config';
import {
  RealtimeAuthRequiredException,
  WsAllExceptionsFilter,
} from '../../core/errors';
import { WsRateLimiter } from '../../core/rate-limit';
import { emitToLocalRoom, evictUserFromRoom } from '../../core/rooms';
import {
  WORK_ITEMS_ACCESS_PORT,
  type WorkItemsAccessPort,
} from '../../ports/work-items';
import { RealtimeEventBus } from '../../core/bus';
import {
  WORK_ITEMS_EVENTS,
  WORK_ITEMS_ROOMS,
  WorkItemsRealtimeConfigService,
} from './config';
import { ProjectRoomWsDto } from './dto';
import { WorkItemsWsGuard } from './guard';

@Injectable()
@UseFilters(WsAllExceptionsFilter)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
@WebSocketGateway({
  cors: createWsCorsOptions(),
  namespace: REALTIME_NAMESPACES.WORK_ITEMS,
})
export class WorkItemsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WorkItemsGateway.name);
  private unsubscribeBus?: () => void;

  constructor(
    private readonly authService: WsAuthService,
    private readonly rateLimiter: WsRateLimiter,
    private readonly workItemsConfig: WorkItemsRealtimeConfigService,
    @Inject(WORK_ITEMS_ACCESS_PORT)
    private readonly accessPort: WorkItemsAccessPort,
    @Optional() private readonly realtimeBus?: RealtimeEventBus,
  ) {}

  public onModuleInit(): void {
    if (!this.realtimeBus) {
      return;
    }

    this.unsubscribeBus = this.realtimeBus.subscribe(async (envelope) => {
      if (envelope.type === 'work-item:event') {
        emitToLocalRoom(
          this.server,
          WORK_ITEMS_ROOMS.project(envelope.projectId),
          envelope.event,
          envelope.payload,
        );
      } else if (envelope.type === 'member:removed') {
        await this.handleMemberRemoved(envelope.projectId, envelope.userId);
      }
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
  }

  public afterInit(server: Server): void {
    server.use(createWsConnectionMiddleware(this.authService));
    this.logger.log('Work Items WebSocket Gateway initialized on /work-items');
  }

  public async handleConnection(client: Socket): Promise<void> {
    try {
      const existingData = client.data as Partial<WsUserSession> | undefined;
      if (!existingData?.authenticated) {
        const session = await this.authService.authenticateSocket(client);
        client.data = {
          ...existingData,
          ...session,
        };
      }

      const userId = this.getAuthenticatedUserId(client);
      this.logger.debug(
        `Work Items socket ${client.id} connected for user ${userId}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Unauthorized work-items socket connection on ${client.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      client.disconnect(true);
    }
  }

  public handleDisconnect(client: Socket): void {
    this.rateLimiter.cleanupSocket(client.id);
  }

  @UseGuards(WorkItemsWsGuard)
  @SubscribeMessage(WORK_ITEMS_EVENTS.JOIN)
  public async handleJoinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ProjectRoomWsDto,
  ) {
    this.enforceRateLimit(client, WORK_ITEMS_EVENTS.JOIN);
    const userId = this.getAuthenticatedUserId(client);

    const projectId = payload.projectId.trim();
    const room = WORK_ITEMS_ROOMS.project(projectId);
    await client.join(room);
    this.logger.debug(`User ${userId} joined work-items room ${room}`);

    return { success: true, projectId };
  }

  @SubscribeMessage(WORK_ITEMS_EVENTS.LEAVE)
  public async handleLeaveProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ProjectRoomWsDto,
  ) {
    this.enforceRateLimit(client, WORK_ITEMS_EVENTS.LEAVE);
    this.getAuthenticatedUserId(client);

    const projectId = payload.projectId.trim();
    await client.leave(WORK_ITEMS_ROOMS.project(projectId));

    return { success: true, projectId };
  }

  public async handleMemberRemoved(
    projectId: string,
    userId: string,
  ): Promise<void> {
    if (!projectId || !userId) {
      return;
    }

    await this.accessPort
      .invalidateAccessCache(projectId, userId)
      .catch(() => {});

    await evictUserFromRoom(
      this.server,
      WORK_ITEMS_ROOMS.project(projectId),
      userId,
      WORK_ITEMS_EVENTS.ACCESS_REVOKED,
      { projectId },
      { localOnly: true },
    );
  }

  private getAuthenticatedUserId(client: Socket): string {
    const data = client.data as Partial<WsUserSession> | undefined;
    if (
      !data?.authenticated ||
      typeof data.userId !== 'string' ||
      data.userId.length === 0
    ) {
      throw new RealtimeAuthRequiredException();
    }
    return data.userId;
  }

  private enforceRateLimit(client: Socket, eventName: string): void {
    this.rateLimiter.consumeOrThrow(
      client,
      eventName,
      this.workItemsConfig.getRateLimitPolicy(),
    );
  }
}
