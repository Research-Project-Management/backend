/**
 * modules/manuscripts/index.ts
 * Root entrypoint and barrel export for the Manuscripts Subsystem
 * (Overleaf-parity modular architecture for LaTeX & Academic Publishing).
 */

export * from './manuscripts.module';

// Subsystems
export * from './clsi';
export * from './docstore';
export * from './structure';
export * from './filestore';
export * from './document-updater';
export * from './project-history';
export * from './track-changes';
export * from './export-import';
export * from './diagnostics';
export * from './citations';
export * from './spelling';
export * from './templates';
export { TemplateNotFoundException } from './templates';
