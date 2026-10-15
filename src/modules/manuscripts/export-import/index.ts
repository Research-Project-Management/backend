/**
 * modules/manuscripts/export-import/index.ts
 * Barrel export for Manuscripts Export-Import subsystem.
 */

export * from './export-import.module';
export * from './export-import.service';
export * from './export-import.controller';
export * from './dto/export-import.dto';

// Repositories
export * from './repositories/manuscript-aggregator.repository';

// Domain (Pure in-process computation & validation)
export {
  ArchiveEntryVo,
  KNOWN_TEXT_EXTENSIONS,
  KNOWN_BINARY_EXTENSIONS,
  ARXIV_ALLOWED_EXTENSIONS,
  isArxivAllowed,
  validateExtractedArchiveEntries,
  ImportSummaryVo,
  ProjectTemplate,
  ArchiveManifest,
  InvalidZipArchiveException,
  ZipSlipSecurityException,
  ArchiveSizeExceededException,
  TemplateNotFoundException as ProjectArchiveTemplateNotFoundException,
} from './domain/archive-validator';
export type {
  EntryStorageType,
  ArchiveEntryProps,
} from './domain/archive-validator';
export {
  DocumentTranspilerAdapter,
  DocumentTranspiler,
} from './domain/document-transpiler';
export type { TranspiledProjectResult } from './domain/document-transpiler';

// Ports
export * from './core/ports/zip-engine.port';
export * from './core/ports/manuscript-aggregator.port';
export * from './core/ports/manuscript-hydrator.port';
export * from './core/ports/template-catalog.port';
