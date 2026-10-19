/**
 * modules/manuscripts/core/core.module.ts
 *
 * Manuscripts Core Module (Shared Kernel)
 * Provides cross-cutting manuscript primitives, contracts, and utilities
 * shared across all 14 manuscript submodules.
 */

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { ProjectWorkspaceCollectorService } from './services/project-workspace-collector.service';
import { ManuscriptUserResolverService } from '@/modules/manuscripts/docstore/services/manuscript-user-resolver.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [ProjectWorkspaceCollectorService, ManuscriptUserResolverService],
  exports: [ProjectWorkspaceCollectorService, ManuscriptUserResolverService],
})
export class ManuscriptsCoreModule {}
