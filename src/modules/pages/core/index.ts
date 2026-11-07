/**
 * modules/pages/core/index.ts
 * Barrel exports for the Pages Shared Kernel (`pages/core`).
 */

// Export ports, domain contracts, and adapters BEFORE core.module to avoid
// circular barrel evaluation when RealtimeModule -> LiveCollaborationProvider extends LiveCollaborationPort.
export * from './config/pages.config';
export * from './domain/workspace-file.interface';
export * from './domain/ssrf-guard';
export * from './domain/latex-escape';
export * from './domain/text-extensions';
export * from './ports/live-collaboration.port';
export * from './ports/distributed-lock.port';
export * from './adapters';
export * from './services/workspace-collector.service';
export * from './services/cleanup.listener';
export * from './services/page.service';
export * from './events/event-bus.service';
export * from './utils/zip-builder';
export * from './utils/saga-runner';
export {
  UserResolverService,
  ManuscriptUserResolverService,
  type ResolvedManuscriptUser,
} from './services/user-resolver.service';
export * from './core.module';
