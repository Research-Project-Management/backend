/**
 * modules/pages/core/core.module.ts
 *
 * Pages Core Module (Shared Kernel)
 * Provides cross-cutting manuscript primitives, contracts, and utilities
 * shared across all 14 pages submodules.
 */

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { IdentityModule } from '@/modules/identity/identity.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { RealtimeModule } from '@/modules/realtime/realtime.module';
import { ManuscriptsConfigService } from './config/pages.config';
import { WorkspaceCollectorService } from './services/workspace-collector.service';
import { ManuscriptDomainEventBus } from './events/event-bus.service';
import { UserResolverService } from './services/user-resolver.service';
import {
  IDistributedLockPort,
  InMemoryDistributedLockAdapter,
} from './ports/distributed-lock.port';
import { RedisLockAdapter } from './adapters/redis-lock.adapter';

import { CleanupListener } from './services/cleanup.listener';

@Global()
@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    NotificationsModule,
    RealtimeModule,
  ],
  providers: [
    ManuscriptsConfigService,
    WorkspaceCollectorService,
    ManuscriptDomainEventBus,
    UserResolverService,
    CleanupListener,
    RedisLockAdapter,
    {
      provide: IDistributedLockPort,
      useClass: RedisLockAdapter,
    },
  ],
  exports: [
    ManuscriptsConfigService,
    WorkspaceCollectorService,
    ManuscriptDomainEventBus,
    UserResolverService,
    IDistributedLockPort,
    RedisLockAdapter,
    NotificationsModule,
    RealtimeModule,
  ],
})
export class ManuscriptsCoreModule {}

/** @deprecated Use ManuscriptsCoreModule */
export { ManuscriptsCoreModule as CoreModule };
