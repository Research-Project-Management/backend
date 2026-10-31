/**
 * modules/manuscripts/core/index.ts
 * Barrel exports for the Manuscripts Shared Kernel (`manuscripts/core`).
 */

export * from './core.module';
export * from './config/manuscripts.config';
export * from './domain/workspace-file.interface';
export * from './domain/ssrf-guard';
export * from './domain/latex-escape';
export * from './domain/text-extensions';
export * from './ports/live-collaboration.port';
export * from './ports/distributed-lock.port';
export * from './adapters';
export * from './services/workspace-collector.service';
export * from './events/event-bus.service';
export * from './utils/pkzip-builder';
export * from './utils/saga-runner';
export {
  ManuscriptUserResolverService,
  type ResolvedManuscriptUser,
} from './services/user-resolver.service';
