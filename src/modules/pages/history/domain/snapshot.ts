import * as crypto from 'node:crypto';
import { VersionLabel } from './label';
import { EmptyProjectException } from './errors';

/**
 * history/core/domain/value-objects/snapshot.ts
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
    docId: string | null,
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

  public toJSON(): Record<string, unknown> {
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


/**
 * history/core/domain/entities/snapshot.ts
 * Domain Aggregate Entity representing an immutable project snapshot at a specific version.
 */

export interface CreateSnapshotProps {
  id?: string;
  projectId: string;
  spaceId?: string;
  pageId?: string;
  version: number;
  summary?: string | null;
  createdById?: string | null;
  isAutomatic?: boolean;
  files:
    | Map<string, FileSnapshotVo>
    | Record<string, FileSnapshotVo | FileSnapshotProps>;
  fileCount?: number;
  labels?: VersionLabel[];
  createdAt?: Date;
}

export class Snapshot {
  private readonly _id: string;
  private readonly _projectId: string;
  private readonly _spaceId: string;
  private readonly _pageId: string | undefined;
  private readonly _version: number;
  private readonly _summary: string | null;
  private readonly _createdById: string | null;
  private readonly _isAutomatic: boolean;
  private readonly _files: Map<string, FileSnapshotVo>;
  private readonly _fileCountOverride?: number;
  private readonly _labels: VersionLabel[];
  private readonly _createdAt: Date;

  private constructor(props: CreateSnapshotProps) {
    this._id = props.id ?? crypto.randomUUID();
    const resolvedSpaceId = props.spaceId ?? props.projectId;
    this._projectId = resolvedSpaceId;
    this._spaceId = resolvedSpaceId;
    this._pageId = props.pageId;
    this._version = props.version;
    this._summary = props.summary ?? null;
    this._createdById = props.createdById ?? null;
    this._isAutomatic = props.isAutomatic ?? false;
    this._fileCountOverride = props.fileCount;
    this._labels = props.labels ? [...props.labels] : [];
    this._createdAt = props.createdAt ?? new Date();

    this._files = new Map<string, FileSnapshotVo>();
    if (props.files instanceof Map) {
      for (const [k, v] of props.files.entries()) {
        this._files.set(k, v);
      }
    } else if (typeof props.files === 'object' && props.files !== null) {
      for (const [k, v] of Object.entries(props.files)) {
        if (v instanceof FileSnapshotVo) {
          this._files.set(k, v);
        } else {
          this._files.set(k, FileSnapshotVo.fromProps(v));
        }
      }
    }

    if (
      this._files.size === 0 &&
      (this._fileCountOverride === undefined || this._fileCountOverride === 0)
    ) {
      throw new EmptyProjectException(this._projectId);
    }
  }

  public static create(props: CreateSnapshotProps): Snapshot {
    return new Snapshot(props);
  }

  public get id(): string {
    return this._id;
  }
  public get projectId(): string {
    return this._projectId;
  }
  public get spaceId(): string {
    return this._spaceId;
  }
  public get pageId(): string | undefined {
    return this._pageId;
  }
  public get version(): number {
    return this._version;
  }
  public get summary(): string | null {
    return this._summary;
  }
  public get createdById(): string | null {
    return this._createdById;
  }
  public get isAutomatic(): boolean {
    return this._isAutomatic;
  }
  public get files(): Map<string, FileSnapshotVo> {
    return new Map(this._files);
  }
  public get fileCount(): number {
    return this._fileCountOverride !== undefined
      ? this._fileCountOverride
      : this._files.size;
  }
  public get labels(): VersionLabel[] {
    return [...this._labels];
  }
  public get createdAt(): Date {
    return this._createdAt;
  }

  public getFile(path: string): FileSnapshotVo | null {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return this._files.get(normalized) ?? null;
  }

  public addLabel(label: VersionLabel): void {
    if (this._labels.some((l) => l.id === label.id)) {
      return;
    }
    this._labels.push(label);
  }

  public removeLabel(labelId: string): void {
    const idx = this._labels.findIndex((l) => l.id === labelId);
    if (idx >= 0) {
      this._labels.splice(idx, 1);
    }
  }

  public toFilesJson(): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    for (const [path, fileVo] of this._files.entries()) {
      record[path] = fileVo.toJSON();
    }
    return record;
  }
}


/**
 * history/domain/snapshot.ts
 * Pure, side-effect-free normalizer transforming any of the 3 database snapshot
 * `files` JSON shapes into a canonical `Map<string, FileSnapshotVo>`.
 */

export interface RawSnapshotFileEntry {
  path?: string;
  type?: FileSnapshotType;
  docId?: string | null;
  fileId?: string | null;
  hash?: string;
  contentHash?: string;
  sizeBytes?: number;
  sizeInBytes?: number;
  lines?: string[] | null;
  content?: string | null;
  textContent?: string | null;
  isRootDoc?: boolean;
}

export class SnapshotNormalizer {
  /**
   * Normalizes database snapshot `files` JSON into a canonical `Map<string, FileSnapshotVo>`.
   */
  public static parseSnapshotFiles(
    rawFiles: unknown,
  ): Map<string, FileSnapshotVo> {
    const filesMap = new Map<string, FileSnapshotVo>();

    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
      return filesMap;
    }

    const entries = rawFiles as Record<string, unknown>;

    for (const [rawKey, rawVal] of Object.entries(entries)) {
      if (rawKey.startsWith('__')) {
        continue;
      }

      const normalizedPath = rawKey.startsWith('/') ? rawKey : `/${rawKey}`;

      if (typeof rawVal === 'string') {
        filesMap.set(
          normalizedPath,
          FileSnapshotVo.createDoc(
            normalizedPath,
            null,
            rawVal.split('\n'),
            crypto.createHash('sha256').update(rawVal).digest('hex'),
            normalizedPath === '/main.tex' || filesMap.size === 0,
          ),
        );
        continue;
      }

      if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
        const obj = rawVal as RawSnapshotFileEntry;
        const resolvedPath =
          typeof obj.path === 'string' && obj.path.trim()
            ? obj.path.startsWith('/')
              ? obj.path
              : `/${obj.path}`
            : normalizedPath;
        const type: FileSnapshotType = obj.type === 'file' ? 'file' : 'doc';

        const lines = Array.isArray(obj.lines)
          ? obj.lines.map((l) => String(l ?? ''))
          : typeof obj.content === 'string'
            ? obj.content.split('\n')
            : typeof obj.textContent === 'string'
              ? obj.textContent.split('\n')
              : type === 'doc'
                ? ['']
                : null;

        const rawText = lines !== null ? lines.join('\n') : null;

        const hash =
          typeof obj.hash === 'string' && obj.hash
            ? obj.hash
            : typeof obj.contentHash === 'string' && obj.contentHash
              ? obj.contentHash
              : rawText !== null
                ? crypto.createHash('sha256').update(rawText).digest('hex')
                : '';

        const sizeBytes =
          typeof obj.sizeBytes === 'number' && !Number.isNaN(obj.sizeBytes)
            ? obj.sizeBytes
            : typeof obj.sizeInBytes === 'number' &&
                !Number.isNaN(obj.sizeInBytes)
              ? obj.sizeInBytes
              : rawText !== null
                ? Buffer.byteLength(rawText, 'utf8')
                : 0;

        const props: FileSnapshotProps = {
          path: resolvedPath,
          type,
          docId: obj.docId ?? null,
          fileId: obj.fileId ?? null,
          hash,
          sizeBytes,
          lines,
          isRootDoc:
            typeof obj.isRootDoc === 'boolean'
              ? obj.isRootDoc
              : resolvedPath === '/main.tex',
        };

        const vo = FileSnapshotVo.fromProps(props);
        filesMap.set(vo.path, vo);
      }
    }

    if (filesMap.size === 0) {
      filesMap.set(
        '/main.tex',
        FileSnapshotVo.createDoc('/main.tex', null, [''], '', true),
      );
    }

    return filesMap;
  }
}
