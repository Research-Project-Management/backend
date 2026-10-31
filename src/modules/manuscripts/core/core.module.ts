/**
 * modules/manuscripts/core/core.module.ts
 *
 * Manuscripts Core Module (Shared Kernel)
 * Provides cross-cutting manuscript primitives, contracts, and utilities
 * shared across all 14 manuscript submodules.
 */

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { IdentityModule } from '@/modules/identity/identity.module';
import { ManuscriptsConfigService } from './config/manuscripts.config';
import { ProjectWorkspaceCollectorService } from './services/workspace-collector.service';
import { ManuscriptDomainEventBus } from './events/event-bus.service';
import { ManuscriptUserResolverService } from './services/user-resolver.service';
import {
  IDistributedLockPort,
  InMemoryDistributedLockAdapter,
} from './ports/distributed-lock.port';
import { RedisDistributedLockAdapter } from './adapters/redis-distributed-lock.adapter';

import { ManuscriptCleanupListener } from './services/cleanup.listener';

@Global()
@Module({
  imports: [PrismaModule, IdentityModule],
  providers: [
    ManuscriptsConfigService,
    ProjectWorkspaceCollectorService,
    ManuscriptDomainEventBus,
    ManuscriptUserResolverService,
    ManuscriptCleanupListener,
    RedisDistributedLockAdapter,
    {
      provide: IDistributedLockPort,
      useClass: RedisDistributedLockAdapter,
    },
  ],
  exports: [
    ManuscriptsConfigService,
    ProjectWorkspaceCollectorService,
    ManuscriptDomainEventBus,
    ManuscriptUserResolverService,
    IDistributedLockPort,
    RedisDistributedLockAdapter,
  ],
})
export class ManuscriptsCoreModule {}
