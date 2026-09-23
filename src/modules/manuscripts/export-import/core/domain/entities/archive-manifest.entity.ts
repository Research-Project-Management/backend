/**
 * export-import/core/domain/entities/archive-manifest.entity.ts
 * Domain Entity representing the manifest/metadata of a project archive package.
 */

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

  public toJSON(): Record<string, any> {
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
