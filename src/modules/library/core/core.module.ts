import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '@/core';

// Configuration
import { libraryConfig, LibraryConfigService } from './config/library.config';

// Core Cross-Cutting Concerns
import { SsrfGuardService } from './services/ssrf-guard.service';
import { AcademicHttpClient } from './services/academic-http.client';
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
 * - 12-Factor Typed Configuration
 */
@Module({
  imports: [ConfigModule.forFeature(libraryConfig), AppCoreModule],
  providers: [
    LibraryConfigService,
    SsrfGuardService,
    AcademicHttpClient,
    IdempotencyMiddleware,
    ResilienceRegistryService,
  ],
  exports: [
    LibraryConfigService,
    SsrfGuardService,
    AcademicHttpClient,
    IdempotencyMiddleware,
    ResilienceRegistryService,
  ],
})
export class LibraryCoreModule {}
