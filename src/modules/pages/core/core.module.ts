/**
 * modules/pages/core/core.module.ts
 *
 * Pages Core Module (Shared Kernel)
 * Provides cross-cutting Pages primitives, contracts, and utilities
 * shared across all pages submodules.
 */

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { IdentityModule } from '@/modules/identity/identity.module';
import { RealtimeClientModule } from '@/modules/realtime/client/module';
import { PagesConfigService } from './config/pages.config';
import { WorkspaceCollectorService } from './services/workspace-collector.service';
import { PageDomainEventBus } from './events/event-bus.service';
import { UserResolverService } from './services/user-resolver.service';

@Global()
@Module({
  imports: [PrismaModule, IdentityModule, RealtimeClientModule],
  providers: [
    PagesConfigService,
    WorkspaceCollectorService,
    PageDomainEventBus,
    UserResolverService,
  ],
  exports: [
    PagesConfigService,
    WorkspaceCollectorService,
    PageDomainEventBus,
    UserResolverService,
    RealtimeClientModule,
  ],
})
export class PagesCoreModule {}
