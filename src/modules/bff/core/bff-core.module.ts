/**
 * modules/bff/core/bff-core.module.ts
 * Shared BFF infrastructure module (channel-scoped cache & resilience).
 */

import { Module } from '@nestjs/common';
import { BffCacheService } from './bff-cache.service';

@Module({
  providers: [BffCacheService],
  exports: [BffCacheService],
})
export class BffCoreModule {}
