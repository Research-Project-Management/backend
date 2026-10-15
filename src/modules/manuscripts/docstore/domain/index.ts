/**
 * modules/manuscripts/docstore/domain/index.ts
 * Barrel export for pure in-process Docstore domain logic.
 */

export * from './doc-hasher';
export * from './text-suggestion-mutator';
export * from './latex-export-transpiler';
export * from '../core/domain/text-doc.entity';
export * from '../core/domain/doc-range.vo';
export * from '../core/domain/doc-errors';
export * from '../core/domain/line-diff';
export * from '../core/domain/text-replace';
export * from './line-array';
export * from './live-collaboration.port';
