import { Readable } from 'node:stream';
import type { ArchiveEntryVo, ArchiveManifest } from '../domain/archive.domain';

export interface RawZipEntryInput {
  path: string;
  data?: Buffer | string;
  getData?: () => Promise<Buffer | string | null>;
  date?: Date;
}

export interface ExportableFileEntry {
  path: string;
  data?: Buffer;
  getData?: () => Promise<Buffer>;
  date?: Date;
}

export interface TranspiledProjectResult {
  mainTex: string;
  entries: ArchiveEntryVo[];
  detectedTitle?: string;
  warnings: string[];
}

export interface ExportProjectZipOutput {
  zipBuffer: Buffer;
  manifest: ArchiveManifest;
}

export interface ExportProjectZipStreamOutput {
  zipStream: Readable;
  projectName: string;
  fileCount: number;
  hasCompiledPdf: boolean;
}

export interface HydrateProjectOptions {
  preferredRootDoc?: string;
  overwrite?: boolean;
  defaultTitle?: string;
  skippedFiles?: string[];
  createNewPage?: boolean;
}

export interface ConvertDocumentInput {
  projectId: string;
  fileBuffer: Buffer;
  fileName: string;
  format?: 'docx' | 'md';
  userId?: string | null;
  pageId?: string;
  createNewPage?: boolean;
}
