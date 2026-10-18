import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '@/core';

// Core Cross-Cutting Concerns
import { SsrfGuardService } from './services/ssrf-guard.service';
import { IdempotencyMiddleware } from './middlewares/idempotency.middleware';

// Resilience Patterns
import { ResilienceRegistryService } from './resilience/resilience-registry.service';

/**
 * Library Core Module — Lean Infrastructure, Domain Primitives & Cross-Cutting Concerns.
 *
 * Provides:
 * - Domain Primitives (Zotero v42 schema, Bibliographic mappings, CSL utilities)
 * - Resilience (Circuit Breaker, Rate Limiter, Resilience Registry)
 * - Security & Middleware (SSRF Guard, Idempotency)
 */
@Module({
  imports: [ConfigModule, AppCoreModule],
  providers: [
    SsrfGuardService,
    IdempotencyMiddleware,
    ResilienceRegistryService,
  ],
  exports: [SsrfGuardService, IdempotencyMiddleware, ResilienceRegistryService],
})
export class LibraryCoreModule {}
