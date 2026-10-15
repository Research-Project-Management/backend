/**
 * modules/manuscripts/diagnostics/index.ts
 * Barrel export for Manuscripts Diagnostics subsystem.
 */

export * from './diagnostics.module';
export * from './diagnostics.service';
export * from './diagnostics.controller';
export * from './diagnostics.repository';
export * from './dto/diagnostics.dto';

// Pure Domain
export * from './domain';

// Ports
export * from './core/ports/latex-log-parser.port';
export * from './core/ports/syntax-linter.port';
export * from './core/ports/error-explainer.port';

// Adapters
export * from './core/adapters/parser/tex-paren-tree-log.parser';
export * from './core/adapters/parser/tectonic-log.parser';
export * from './core/adapters/linter/fast-syntax-linter.adapter';
export * from './core/adapters/explainer/knowledge-base-explainer.adapter';

// Use Cases
export * from './core/use-cases/parse-compile-log.use-case';
export * from './core/use-cases/lint-document-syntax.use-case';
export * from './core/use-cases/get-error-explanation.use-case';
