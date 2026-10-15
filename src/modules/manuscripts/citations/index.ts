/**
 * citations/index.ts
 * Public entrypoint and barrel export for the Manuscripts Citations subsystem.
 */

export * from './citations.module';
export * from './citations.service';
export * from './citations.repository';
export * from './citations.controller';
export * from './dto/citations.dto';
export * from './domain';

// Backward-compatible re-exports on core/*
export * from './core/ports/bibtex-parser.port';
export * from './core/ports/identifier-resolver.port';
export * from './core/ports/citations-aggregator.port';
export * from './core/ports/library-sync.port';
export * from './core/use-cases/search-citation-keys.use-case';
export * from './core/use-cases/resolve-identifier-to-bib.use-case';
export * from './core/use-cases/validate-project-bibtex.use-case';
export * from './core/use-cases/sync-library-collection.use-case';
export * from './core/adapters/parser/regex-ast-bibtex.parser';
export * from './core/adapters/resolver/crossref-arxiv.resolver';
export * from './core/adapters/external/manuscript-bib-aggregator.adapter';
export * from './core/adapters/library/pluggable-library-sync.adapter';
