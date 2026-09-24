/**
 * modules/manuscripts/structure/index.ts
 * Public entrypoint and barrel export for the Manuscripts Structure subsystem
 * (File tree, folder hierarchy, sort order, root doc resolution).
 */

export * from './structure.module';
export * from './structure.service';
export * from './structure.controller';

// Domain
export * from './core/domain/manuscript-node.entity';
export * from './core/domain/node-path.vo';
export * from './core/domain/structure-errors';

// Ports
export * from './core/ports/structure-repository.port';
export * from './core/ports/root-doc-detector.port';
export * from './core/ports/tree-publisher.port';

// Use Cases
export * from './core/use-cases/get-file-tree.use-case';
export * from './core/use-cases/create-node.use-case';
export * from './core/use-cases/move-node.use-case';
export * from './core/use-cases/rename-node.use-case';
export * from './core/use-cases/delete-node.use-case';
export * from './core/use-cases/resolve-root-doc.use-case';
export * from './core/use-cases/build-compiler-files.use-case';
