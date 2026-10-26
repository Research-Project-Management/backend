/**
 * modules/manuscripts/core/core.module.ts
 *
 * Manuscripts Core Module (Shared Kernel)
 * Provides cross-cutting manuscript primitives, contracts, and utilities
 * shared across all 14 manuscript submodules.
 */

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { ManuscriptsConfigService } from './config/manuscripts.config';
import { ProjectWorkspaceCollectorService } from './services/project-workspace-collector.service';
import { ManuscriptDomainEventBus } from './events/manuscript-domain-event-bus.service';
import { ManuscriptUserResolverService } from '@/modules/manuscripts/docstore/services/manuscript-user-resolver.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    ManuscriptsConfigService,
    ProjectWorkspaceCollectorService,
    ManuscriptDomainEventBus,
    ManuscriptUserResolverService,
  ],
  exports: [
    ManuscriptsConfigService,
    ProjectWorkspaceCollectorService,
    ManuscriptDomainEventBus,
    ManuscriptUserResolverService,
  ],
})
export class ManuscriptsCoreModule {}
