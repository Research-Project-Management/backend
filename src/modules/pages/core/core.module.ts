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
import { RealtimeClientModule } from '@/modules/realtime/client/module';
import { PagesConfigService } from './config/pages.config';
import { WorkspaceCollectorService } from './services/workspace-collector.service';
import { PageDomainEventBus } from './events/event-bus.service';
import { UserResolverService } from './services/user-resolver.service';
import { IDistributedLockPort } from './ports/distributed-lock.port';
import { RedisLockAdapter } from './adapters/redis-lock.adapter';

@Global()
@Module({
  imports: [PrismaModule, IdentityModule, RealtimeClientModule],
  providers: [
    PagesConfigService,
    WorkspaceCollectorService,
    PageDomainEventBus,
    UserResolverService,
    RedisLockAdapter,
    {
      provide: IDistributedLockPort,
      useExisting: RedisLockAdapter,
    },
  ],
  exports: [
    PagesConfigService,
    WorkspaceCollectorService,
    PageDomainEventBus,
    UserResolverService,
    IDistributedLockPort,
    RealtimeClientModule,
  ],
})
export class PagesCoreModule {}
