/**
 * modules/manuscripts/docstore/index.ts
 * Public entrypoint and barrel export for the Manuscripts Docstore subsystem
 * (Document storage, lines array representation, OCC, hashing).
 */

export * from './docstore.module';
export * from './docstore.service';
export * from './docstore.controller';
export * from './pages-bridge.controller';

// Domain
export * from './core/domain/text-doc.entity';
export * from './core/domain/doc-range.vo';
export * from './core/domain/doc-errors';

// Ports
export * from './core/ports/doc-repository.port';
export * from './core/ports/doc-persistor.port';
export * from './core/ports/doc-hasher.port';

// Use Cases
export * from './core/use-cases/get-doc.use-case';
export * from './core/use-cases/peek-doc.use-case';
export * from './core/use-cases/update-doc.use-case';
export * from './core/use-cases/patch-doc.use-case';
export * from './core/use-cases/get-all-docs.use-case';
export * from './core/use-cases/archive-project.use-case';
