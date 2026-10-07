export * from './library.module';
export * from './library.facade';

// Export canonical bounded contexts as isolated namespaces to avoid TS2308 collision
export * as Catalog from './catalog';
export * as Citation from './citation';
export * as Extraction from './extraction';
export * as Ingestion from './ingestion';
export * as Search from './search';
export * as Sync from './sync';
export * as SharedKernel from './shared-kernel';
