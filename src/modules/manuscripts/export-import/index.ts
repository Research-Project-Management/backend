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

// Services & Adapters
export { PkzipEngineAdapter } from './services/pkzip-engine.adapter';
export { DocumentTranspilerAdapter } from './services/document-transpiler.adapter';

// Domain (Pure in-process computation, validation, & ports)
export {
  ArchiveEntryVo,
  KNOWN_TEXT_EXTENSIONS,
  KNOWN_BINARY_EXTENSIONS,
  ARXIV_ALLOWED_EXTENSIONS,
  isArxivAllowed,
  validateExtractedArchiveEntries,
  ImportSummaryVo,
  ArchiveManifest,
  InvalidZipArchiveException,
  ZipSlipSecurityException,
  ArchiveSizeExceededException,
  IZipEnginePort,
  IManuscriptAggregatorPort,
  IManuscriptHydratorPort,
  IDocumentTranspilerPort,
  MAX_UNCOMPRESSED_PROJECT_BYTES,
  MAX_PROJECT_ENTRY_COUNT,
  escapeLatex,
  unescapeXml,
  escapeXml,
  convertLatexToMarkdown,
  convertLatexToHtml,
  buildMinimalZip,
  convertLatexToDocxBuffer,
  resolveIncludedLatexContent,
  transpileLatexDocumentForExport,
  LatexExportTranspiler,
} from './domain';
export type {
  EntryStorageType,
  ArchiveEntryProps,
  ArchiveManifestProps,
  ImportSummaryProps,
  RawZipEntryInput,
  ExportableFileEntry,
  TranspiledProjectResult,
  IncludedProjectDoc,
  ExportFormattedDocResult,
} from './domain';
