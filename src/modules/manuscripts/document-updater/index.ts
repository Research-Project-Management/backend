/**
 * document-updater/index.ts
 * Barrel export for Manuscripts Document Updater subsystem
 */

export * from './document-updater.module';
export * from './document-updater.service';
export * from './document-updater.repository';
export * from './document-updater.controller';
export * from './dto/queue-update.dto';
export * from './dto/flush-project.dto';
export * from './dto/flush-result.dto';
export * from './dto/in-flight-doc-state.dto';
export * from './domain';

// Backward-compatible re-exports on core/*
export * from './core/ports/in-flight-store.port';
export * from './core/ports/docstore-writer.port';
export * from './core/ports/updater-lock.port';
export * from './core/ports/debounce-timer.port';
export * from './core/use-cases/queue-doc-update.use-case';
export * from './core/use-cases/flush-project-docs.use-case';
export * from './core/use-cases/flush-single-doc.use-case';
export * from './core/use-cases/get-in-flight-doc.use-case';
export * from './core/use-cases/evict-doc-buffer.use-case';
