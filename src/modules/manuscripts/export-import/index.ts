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

// Domain (Pure in-process computation, validation, & ports)
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
  TemplateNotFoundException,
  IZipEnginePort,
  IManuscriptAggregatorPort,
  IManuscriptHydratorPort,
  ITemplateCatalogPort,
  IDocumentTranspilerPort,
  PkzipEngineAdapter,
  MAX_UNCOMPRESSED_PROJECT_BYTES,
  MAX_PROJECT_ENTRY_COUNT,
  DocumentTranspilerAdapter,
  DocumentTranspiler,
  escapeLatex,
  unescapeXml,
} from './domain';
export type {
  EntryStorageType,
  ArchiveEntryProps,
  ArchiveManifestProps,
  TemplateFileSpec,
  CreateProjectTemplateProps,
  TemplateSummaryProps,
  ImportSummaryProps,
  RawZipEntryInput,
  ExportableFileEntry,
  TranspiledProjectResult,
} from './domain';
