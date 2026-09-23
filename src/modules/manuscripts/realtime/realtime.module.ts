/**
 * realtime/realtime.module.ts
 * NestJS Module for Manuscripts Real-Time Collaboration Gateway (Hexagonal Architecture).
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core/database/prisma.module';
import { CacheModule } from '@/core/cache/cache.module';
import { DocumentUpdaterModule } from '../document-updater/document-updater.module';

import { ManuscriptRealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

// Use Cases
import { JoinProjectUseCase } from './core/use-cases/join-project.use-case';
import { LeaveProjectUseCase } from './core/use-cases/leave-project.use-case';
import { JoinDocUseCase } from './core/use-cases/join-doc.use-case';
import { LeaveDocUseCase } from './core/use-cases/leave-doc.use-case';
import { SendDocUpdateUseCase } from './core/use-cases/send-doc-update.use-case';
import { BroadcastCursorUseCase } from './core/use-cases/broadcast-cursor.use-case';
import { BroadcastProjectEventUseCase } from './core/use-cases/broadcast-project-event.use-case';

// Ports
import { IRoomManagerPort } from './core/ports/room-manager.port';
import { IDocumentUpdaterBridgePort } from './core/ports/document-updater-bridge.port';
import { IProjectAccessVerifierPort } from './core/ports/project-access-verifier.port';
import { IRealtimeBroadcasterPort } from './core/ports/realtime-broadcaster.port';

// Adapters
import { RedisRoomManagerAdapter } from './core/adapters/storage/redis-room-manager.adapter';
import { InMemoryRoomManagerAdapter } from './core/adapters/storage/in-memory-room-manager.adapter';
import { DocumentUpdaterBridgeAdapter } from './core/adapters/external/document-updater-bridge.adapter';
import { ProjectAccessVerifierAdapter } from './core/adapters/external/project-access-verifier.adapter';
import { SocketIoBroadcasterAdapter } from './core/adapters/broadcast/socket-io-broadcaster.adapter';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    PrismaModule,
    CacheModule,
    DocumentUpdaterModule,
  ],
  providers: [
    ManuscriptRealtimeGateway,
    RealtimeService,

    // Use Cases
    JoinProjectUseCase,
    LeaveProjectUseCase,
    JoinDocUseCase,
    LeaveDocUseCase,
    SendDocUpdateUseCase,
    BroadcastCursorUseCase,
    BroadcastProjectEventUseCase,

    // Driven Adapters
    RedisRoomManagerAdapter,
    InMemoryRoomManagerAdapter,
    DocumentUpdaterBridgeAdapter,
    ProjectAccessVerifierAdapter,
    SocketIoBroadcasterAdapter,

    // Ports SPI Bindings
    {
      provide: IRoomManagerPort,
      useClass: RedisRoomManagerAdapter,
    },
    {
      provide: IDocumentUpdaterBridgePort,
      useClass: DocumentUpdaterBridgeAdapter,
    },
    {
      provide: IProjectAccessVerifierPort,
      useClass: ProjectAccessVerifierAdapter,
    },
    {
      provide: IRealtimeBroadcasterPort,
      useClass: SocketIoBroadcasterAdapter,
    },
  ],
  exports: [
    RealtimeService,
    ManuscriptRealtimeGateway,
    IRoomManagerPort,
    IDocumentUpdaterBridgePort,
    IProjectAccessVerifierPort,
    IRealtimeBroadcasterPort,
    JoinProjectUseCase,
    LeaveProjectUseCase,
    JoinDocUseCase,
    LeaveDocUseCase,
    SendDocUpdateUseCase,
    BroadcastCursorUseCase,
    BroadcastProjectEventUseCase,
  ],
})
export class RealtimeModule {}
