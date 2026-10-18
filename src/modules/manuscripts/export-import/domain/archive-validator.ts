/**
 * modules/manuscripts/export-import/domain/archive-validator.ts
 * Pure in-process domain logic, entities, value objects, exceptions, and ports
 * for ZIP archive entry validation, Zip Slip security defense, OS artifact filtering,
 * arXiv submission whitelist checks, and text vs. binary classification.
 */

import { Readable } from 'node:stream';

export class ZipSlipSecurityException extends Error {
  constructor(entryPath: string) {
    super(
      `Security Violation: Zip entry '${entryPath}' contains illegal path traversal sequences.`,
    );
    this.name = 'ZipSlipSecurityException';
  }
}

export class ArchiveFileLimitExceededException extends Error {
  constructor(maxFiles: number) {
    super(
      `ZIP archive exceeds the maximum project file limit of ${maxFiles.toLocaleString()} files.`,
    );
    this.name = 'ArchiveFileLimitExceededException';
  }
}

export class InvalidZipArchiveException extends Error {
  constructor(
    message = 'The provided archive is not a valid ZIP file or contains no usable entries.',
  ) {
    super(message);
    this.name = 'InvalidZipArchiveException';
  }
}

export class ArchiveSizeExceededException extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `Archive payload exceeds maximum allowed project uncompressed size of ${Math.round(maxBytes / (1024 * 1024))}MB. Found: ${Math.round(sizeBytes / (1024 * 1024))}MB.`,
    );
    this.name = 'ArchiveSizeExceededException';
  }
}

export class TemplateNotFoundException extends Error {
  constructor(templateId: string) {
    super(
      `Manuscript project template '${templateId}' was not found in catalog.`,
    );
    this.name = 'TemplateNotFoundException';
  }
}

export interface ArchiveManifestProps {
  projectId: string;
  projectName?: string;
  generatedAt?: Date;
  fileCount: number;
  totalSizeBytes: number;
  hasCompiledPdf?: boolean;
}

export class ArchiveManifest {
  public readonly projectId: string;
  public readonly projectName: string;
  public readonly generatedAt: Date;
  public readonly fileCount: number;
  public readonly totalSizeBytes: number;
  public readonly hasCompiledPdf: boolean;

  constructor(props: ArchiveManifestProps) {
    this.projectId = props.projectId;
    this.projectName = props.projectName || `manuscript-${props.projectId}`;
    this.generatedAt = props.generatedAt ?? new Date();
    this.fileCount = props.fileCount;
    this.totalSizeBytes = props.totalSizeBytes;
    this.hasCompiledPdf = props.hasCompiledPdf ?? false;
  }

  public toJSON(): Record<string, unknown> {
    return {
      projectId: this.projectId,
      projectName: this.projectName,
      generatedAt: this.generatedAt.toISOString(),
      fileCount: this.fileCount,
      totalSizeBytes: this.totalSizeBytes,
      hasCompiledPdf: this.hasCompiledPdf,
    };
  }
}

export interface TemplateFileSpec {
  path: string;
  content: string | Buffer;
  isBinary?: boolean;
}

export interface CreateProjectTemplateProps {
  id: string;
  title: string;
  category:
    | 'journal'
    | 'article'
    | 'conference'
    | 'thesis'
    | 'presentation'
    | 'report'
    | 'book'
    | 'letter'
    | 'assignment'
    | 'poster'
    | 'cv'
    | 'other'
    | string;
  description: string;
  author: string;
  thumbnailUrl?: string | null;
  files: TemplateFileSpec[];
  defaultRootDoc?: string;
}

export interface TemplateSummaryProps {
  id: string;
  title: string;
  category: string;
  description: string;
  author: string;
  thumbnailUrl: string | null;
  fileCount: number;
  defaultRootDoc: string;
}

export class ProjectTemplate {
  public readonly id: string;
  public readonly title: string;
  public readonly category: string;
  public readonly description: string;
  public readonly author: string;
  public readonly thumbnailUrl: string | null;
  public readonly files: TemplateFileSpec[];
  public readonly defaultRootDoc: string;

  constructor(props: CreateProjectTemplateProps) {
    this.id = props.id;
    this.title = props.title;
    this.category = props.category;
    this.description = props.description;
    this.author = props.author;
    this.thumbnailUrl = props.thumbnailUrl ?? null;
    this.files = props.files;
    this.defaultRootDoc = props.defaultRootDoc || 'main.tex';
  }

  public toJSON(): TemplateSummaryProps {
    return {
      id: this.id,
      title: this.title,
      category: this.category,
      description: this.description,
      author: this.author,
      thumbnailUrl: this.thumbnailUrl,
      fileCount: this.files.length,
      defaultRootDoc: this.defaultRootDoc,
    };
  }
}

export interface ImportSummaryProps {
  projectId: string;
  totalEntries: number;
  totalDocs: number;
  totalFiles: number;
  totalFolders: number;
  rootDocId: string | null;
  rootDocPath: string | null;
}

export class ImportSummaryVo {
  public readonly projectId: string;
  public readonly totalEntries: number;
  public readonly totalDocs: number;
  public readonly totalFiles: number;
  public readonly totalFolders: number;
  public readonly rootDocId: string | null;
  public readonly rootDocPath: string | null;

  constructor(props: ImportSummaryProps) {
    this.projectId = props.projectId;
    this.totalEntries = props.totalEntries;
    this.totalDocs = props.totalDocs;
    this.totalFiles = props.totalFiles;
    this.totalFolders = props.totalFolders;
    this.rootDocId = props.rootDocId;
    this.rootDocPath = props.rootDocPath;
  }

  public toJSON(): ImportSummaryProps {
    return {
      projectId: this.projectId,
      totalEntries: this.totalEntries,
      totalDocs: this.totalDocs,
      totalFiles: this.totalFiles,
      totalFolders: this.totalFolders,
      rootDocId: this.rootDocId,
      rootDocPath: this.rootDocPath,
    };
  }
}

export type EntryStorageType = 'doc' | 'file';

export const KNOWN_TEXT_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bbl',
  '.bst',
  '.txt',
  '.md',
  '.latex',
  '.dtx',
  '.ins',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.lua',
  '.py',
  '.sh',
  '.gitignore',
  '.latexmkrc',
]);

export const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.webp',
  '.ico',
  '.pdf',
  '.eps',
  '.ai',
  '.psd',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
]);

export const ARXIV_ALLOWED_EXTENSIONS = new Set([
  'tex',
  'ltx',
  'rtex',
  'sty',
  'cls',
  'bst',
  'def',
  'fd',
  'cfg',
  'clo',
  'bbx',
  'cbx',
  'bib',
  'bbl',
  'tikz',
  'pgf',
  'png',
  'jpg',
  'jpeg',
  'pdf',
  'eps',
  'ps',
  'svg',
  'csv',
  'dat',
  'txt',
]);

export function isArxivAllowed(relPath: string): boolean {
  const clean = relPath.trim().toLowerCase();
  const base = clean.split('/').pop() || '';
  if (base.startsWith('.') || base.startsWith('__macosx')) return false;
  if (/\.(aux|log|out|synctex\.gz|toc|lof|lot|fls|fdb_latexmk)$/i.test(base))
    return false;
  const ext = base.split('.').pop() || '';
  return ARXIV_ALLOWED_EXTENSIONS.has(ext);
}

export interface ArchiveEntryProps {
  path: string;
  data: Buffer;
  isDirectory?: boolean;
}

export class ArchiveEntryVo {
  public readonly path: string;
  public readonly data: Buffer;
  public readonly isDirectory: boolean;
  public readonly sizeBytes: number;

  private constructor(path: string, data: Buffer, isDirectory: boolean) {
    this.path = path;
    this.data = data;
    this.isDirectory = isDirectory;
    this.sizeBytes = data.length;
  }

  public static create(
    rawPath: string,
    data: Buffer = Buffer.alloc(0),
    isDirectory = false,
  ): ArchiveEntryVo {
    const normalized = rawPath.replace(/\\/g, '/');

    const segments = normalized.split('/');
    if (
      segments.includes('..') ||
      /^[a-zA-Z]:/.test(normalized) ||
      /^\/+(etc|var|usr|bin|sbin|proc|sys|dev|root|home|boot|lib)\b/i.test(
        normalized,
      )
    ) {
      throw new ZipSlipSecurityException(rawPath);
    }

    const clean = normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const isDir = isDirectory || clean.endsWith('/');
    const trimmedPath = clean.replace(/\/+$/, '');

    return new ArchiveEntryVo(trimmedPath, data, isDir);
  }

  public isIgnoredSystemArtifact(): boolean {
    const p = this.path;
    return (
      p.startsWith('__MACOSX/') ||
      p.includes('/__MACOSX/') ||
      p.endsWith('.DS_Store') ||
      p.endsWith('/.DS_Store') ||
      p.endsWith('Thumbs.db') ||
      p.endsWith('/Thumbs.db') ||
      p.startsWith('.git/') ||
      p.includes('/.git/')
    );
  }

  public getStorageType(): EntryStorageType {
    if (this.isDirectory) return 'doc';

    const lastDot = this.path.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = this.path.slice(lastDot).toLowerCase();
      if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
        return 'file';
      }
      if (KNOWN_TEXT_EXTENSIONS.has(ext)) {
        return 'doc';
      }
    }

    if (this.data.length <= 2 * 1024 * 1024) {
      if (this.isUtf8Text(this.data)) {
        return 'doc';
      }
    }

    return 'file';
  }

  private isUtf8Text(buffer: Buffer): boolean {
    if (buffer.length === 0) return true;
    const sampleSize = Math.min(buffer.length, 1024);
    for (let i = 0; i < sampleSize; i++) {
      if (buffer[i] === 0) {
        return false;
      }
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, sampleSize),
      );
      return true;
    } catch {
      return false;
    }
  }
}

export function validateExtractedArchiveEntries(
  entries: ArchiveEntryVo[],
  maxFiles = 2000,
): ArchiveEntryVo[] {
  if (entries.length === 0) {
    throw new InvalidZipArchiveException(
      'Provided ZIP archive contains no usable file entries.',
    );
  }
  if (entries.length > maxFiles) {
    throw new ArchiveFileLimitExceededException(maxFiles);
  }
  return entries;
}

export interface RawZipEntryInput {
  path: string;
  data?: Buffer | string;
  getData?: () => Promise<Buffer | string>;
  date?: Date;
}

export abstract class IZipEnginePort {
  abstract buildZip(entries: RawZipEntryInput[]): Buffer;
  abstract createZipStream(entries: RawZipEntryInput[]): Readable;
  abstract extractZip(zipBuffer: Buffer): ArchiveEntryVo[];
}

export interface ExportableFileEntry {
  path: string;
  data?: Buffer;
  getData?: () => Promise<Buffer>;
  date?: Date;
}

export abstract class IManuscriptAggregatorPort {
  abstract collectProjectEntries(
    projectId: string,
    includePdf?: boolean,
    cleanArxiv?: boolean,
  ): Promise<ExportableFileEntry[]>;

  abstract collectLazyProjectEntries(
    projectId: string,
    includePdf?: boolean,
    cleanArxiv?: boolean,
  ): Promise<ExportableFileEntry[]>;
}

export abstract class IManuscriptHydratorPort {
  abstract hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
  ): Promise<ImportSummaryVo>;
}

export abstract class ITemplateCatalogPort {
  abstract listTemplates(): Promise<ProjectTemplate[]>;
  abstract getTemplateById(templateId: string): Promise<ProjectTemplate | null>;
}

export interface TranspiledProjectResult {
  mainTex: string;
  entries: ArchiveEntryVo[];
  detectedTitle?: string;
  warnings: string[];
}

export abstract class IDocumentTranspilerPort {
  abstract transpileMarkdown(
    content: string,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;

  abstract transpileDocx(
    docxBuffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;
}

export const MAX_UNCOMPRESSED_PROJECT_BYTES = 500 * 1024 * 1024;
export const MAX_PROJECT_ENTRY_COUNT = 10000;


export { PkzipEngineAdapter } from '../services/pkzip-engine.adapter';
