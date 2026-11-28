import { ZipSlipSecurityException } from './archive.errors';
import {
  classifyEntryStorageType,
  isIgnoredSystemArtifactPath,
  isUnsafeArchivePath,
} from './archive.policy';

export type EntryStorageType = 'doc' | 'file';

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

export interface ImportSummaryProps {
  pageId?: string;
  projectId: string;
  totalEntries: number;
  totalDocs: number;
  totalFiles: number;
  totalFolders: number;
  rootDocId: string | null;
  rootDocPath: string | null;
  title?: string;
  skippedFiles?: string[];
}

export interface ImportSummaryJson {
  pageId: string;
  projectId: string;
  rootDocId: string;
  rootDocPath: string | null;
  title: string;
  totalEntries: number;
  totalDocs: number;
  totalFiles: number;
  totalFolders: number;
  skippedFiles: string[];
}

export class ImportSummaryVo {
  public readonly pageId: string;
  public readonly projectId: string;
  public readonly totalEntries: number;
  public readonly totalDocs: number;
  public readonly totalFiles: number;
  public readonly totalFolders: number;
  public readonly rootDocId: string;
  public readonly rootDocPath: string | null;
  public readonly title: string;
  public readonly skippedFiles: string[];

  constructor(props: ImportSummaryProps) {
    this.projectId = props.projectId;
    this.pageId = props.pageId || props.rootDocId || props.projectId;
    this.totalEntries = props.totalEntries;
    this.totalDocs = props.totalDocs;
    this.totalFiles = props.totalFiles;
    this.totalFolders = props.totalFolders;
    this.rootDocId = props.rootDocId ?? this.pageId;
    this.rootDocPath = props.rootDocPath;
    this.title = props.title || 'Untitled';
    this.skippedFiles = props.skippedFiles ? [...props.skippedFiles] : [];
  }

  public toJSON(): ImportSummaryJson {
    return {
      pageId: this.pageId,
      projectId: this.projectId,
      rootDocId: this.rootDocId,
      rootDocPath: this.rootDocPath,
      title: this.title,
      totalEntries: this.totalEntries,
      totalDocs: this.totalDocs,
      totalFiles: this.totalFiles,
      totalFolders: this.totalFolders,
      skippedFiles: [...this.skippedFiles],
    };
  }
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
    if (isUnsafeArchivePath(normalized)) {
      throw new ZipSlipSecurityException(rawPath);
    }

    const clean = normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const isDir = isDirectory || clean.endsWith('/');
    const trimmedPath = clean.replace(/\/+$/, '');

    return new ArchiveEntryVo(trimmedPath, data, isDir);
  }

  public isIgnoredSystemArtifact(): boolean {
    return isIgnoredSystemArtifactPath(this.path);
  }

  public getStorageType(): EntryStorageType {
    return classifyEntryStorageType(this.path, this.data, this.isDirectory);
  }
}
