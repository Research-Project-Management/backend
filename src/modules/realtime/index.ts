/**
 * realtime/index.ts
 * Enterprise Root Entrypoint for Flux Real-Time Ecosystem.
 * Aggregates all domain submodules: Manuscripts, Notifications, and Collaboration.
 */

export * from './realtime.module';
export * from './realtime.service';

// Manuscripts Domain Submodule
export * from './manuscripts';

// Notifications Domain Submodule
export * from './notifications';
