/**
 * export-import/core/domain/value-objects/import-summary.vo.ts
 * Value Object summarizing the outcome of a ZIP project import or template scaffolding.
 */

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

  public toJSON(): Record<string, any> {
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
