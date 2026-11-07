/**
 * modules/pages/index.ts
 * Root entrypoint and barrel export for the Pages Subsystem
 * (Overleaf-parity modular architecture for LaTeX & Academic Publishing).
 */

export * from './pages.module';
export * from './pages.facade';
export * from './core';

// Subsystem 1: Virtual File System & Storage
export * from './filestore';
export * from './docstore';
export * from './structure';

// Subsystem 3: Compilation & Diagnostics
export * from './diagnostics';
export * from './clsi';

// Subsystem 4: Review & Versioning
export * from './track-changes';
export * from './project-history';

// Subsystem 5: Academic Authoring & Packaging
export * from './spelling';
export * from './citations';
export * from './templates';
export * from './export-import';
export * from './git-bridge';
