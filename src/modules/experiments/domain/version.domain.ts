export interface ExperimentVersionAuthor {
  id: string;
  name?: string;
  avatar?: string | null;
  email?: string | null;
}

export interface ExperimentVersionProps {
  id: string;
  fileId: string;
  blobId: string;
  versionNumber: number;
  changeComment?: string | null;
  createdById: string;
  createdAt?: Date;
  sizeBytes?: bigint;
  mimeType?: string;
  author?: ExperimentVersionAuthor | null;
}

/**
 * Immutable historical revision snapshot of an experiment file.
 */
export class ExperimentVersion {
  public readonly id: string;
  public readonly fileId: string;
  public readonly blobId: string;
  public readonly versionNumber: number;
  public readonly changeComment: string | null;
  public readonly createdById: string;
  public readonly createdAt: Date;
  public readonly sizeBytes: bigint;
  public readonly mimeType: string;
  public readonly author: ExperimentVersionAuthor | null;

  constructor(props: ExperimentVersionProps) {
    this.id = props.id;
    this.fileId = props.fileId;
    this.blobId = props.blobId;
    this.versionNumber = props.versionNumber;
    this.changeComment = props.changeComment ?? null;
    this.createdById = props.createdById;
    this.createdAt = props.createdAt ?? new Date();
    this.sizeBytes = props.sizeBytes ?? 0n;
    this.mimeType = props.mimeType ?? 'application/octet-stream';
    this.author = props.author ?? null;
  }
}
