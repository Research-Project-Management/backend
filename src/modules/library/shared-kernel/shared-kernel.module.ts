import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '../../../core/core.module';

// ── 1. Infrastructure Sidecar Clients ─────────────────────────────────────
import { GrobidClient } from './infra/grobid/grobid.client';
import { ZoteroTranslatorClient } from './infra/zotero/zotero-translator.client';

// ── 3. Core Cross-Cutting Concerns ────────────────────────────────────────
import { SsrfGuardService } from './core/services/ssrf-guard.service';
import { CorrelationIdMiddleware } from './core/middlewares/correlation-id.middleware';
import { IdempotencyMiddleware } from './core/middlewares/idempotency.middleware';
import { DomainExceptionFilter } from './core/filters/domain-exception.filter';

// ── 4. Resilience Patterns ────────────────────────────────────────────────
import { ResilienceRegistryService } from './resilience/resilience-registry.service';

/**
 * Shared Kernel Module — Lean Infrastructure & Cross-Cutting Concerns.
 *
 * Strict single-responsibility: provides only shared primitives consumed by
 * all bounded contexts. Does NOT manage the Outbox or Queue — that belongs
 * entirely to SyncModule.
 *
 * Provides:
 * - Integration Event Bus (in-process async cross-BC event router)
 * - Sidecar Clients (GROBID Extraction Server, Zotero Translation Server)
 * - SSRF Guard, Correlation ID, Idempotency middleware
 * - Circuit Breaker & Rate Limiter Registry (Resilience)
 */
@Module({
  imports: [ConfigModule, AppCoreModule],
  providers: [
    // External Sidecar Clients
    GrobidClient,
    ZoteroTranslatorClient,

    // Core Cross-Cutting Utilities
    SsrfGuardService,
    CorrelationIdMiddleware,
    IdempotencyMiddleware,
    DomainExceptionFilter,

    // Resilience
    ResilienceRegistryService,
  ],
  exports: [
    // External Sidecar Clients
    GrobidClient,
    ZoteroTranslatorClient,

    // Core Cross-Cutting Utilities
    SsrfGuardService,
    CorrelationIdMiddleware,
    IdempotencyMiddleware,
    DomainExceptionFilter,

    // Resilience
    ResilienceRegistryService,
  ],
})
export class SharedKernelModule {}
