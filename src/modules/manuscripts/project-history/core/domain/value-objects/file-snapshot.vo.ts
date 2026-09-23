/**
 * project-history/core/domain/value-objects/file-snapshot.vo.ts
 * Value Object representing an immutable file entry in a project history snapshot.
 */

export type FileSnapshotType = 'doc' | 'file';

export interface FileSnapshotProps {
  path: string;
  type: FileSnapshotType;
  docId?: string | null;
  fileId?: string | null;
  hash: string;
  sizeBytes: number;
  lines?: string[] | null;
  isRootDoc?: boolean;
}

export class FileSnapshotVo {
  public readonly path: string;
  public readonly type: FileSnapshotType;
  public readonly docId?: string | null;
  public readonly fileId?: string | null;
  public readonly hash: string;
  public readonly sizeBytes: number;
  public readonly lines?: string[] | null;
  public readonly isRootDoc: boolean;

  private constructor(props: FileSnapshotProps) {
    this.path = props.path.startsWith('/') ? props.path : `/${props.path}`;
    this.type = props.type;
    this.docId = props.docId ?? null;
    this.fileId = props.fileId ?? null;
    this.hash = props.hash;
    this.sizeBytes = props.sizeBytes;
    this.lines = props.lines ? [...props.lines] : null;
    this.isRootDoc = props.isRootDoc ?? false;
  }

  public static createDoc(
    path: string,
    docId: string,
    lines: string[],
    hash: string,
    isRootDoc = false,
  ): FileSnapshotVo {
    const text = lines.join('\n');
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    return new FileSnapshotVo({
      path,
      type: 'doc',
      docId,
      lines,
      hash,
      sizeBytes,
      isRootDoc,
    });
  }

  public static createFile(
    path: string,
    fileId: string,
    hash: string,
    sizeBytes: number,
  ): FileSnapshotVo {
    return new FileSnapshotVo({
      path,
      type: 'file',
      fileId,
      hash,
      sizeBytes,
      lines: null,
      isRootDoc: false,
    });
  }

  public static fromProps(props: FileSnapshotProps): FileSnapshotVo {
    return new FileSnapshotVo(props);
  }

  public toJSON(): Record<string, any> {
    return {
      path: this.path,
      type: this.type,
      docId: this.docId,
      fileId: this.fileId,
      hash: this.hash,
      sizeBytes: this.sizeBytes,
      lines: this.lines,
      isRootDoc: this.isRootDoc,
    };
  }
}
