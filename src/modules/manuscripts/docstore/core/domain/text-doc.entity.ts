/**
 * modules/manuscripts/docstore/core/domain/text-doc.entity.ts
 * Rich Domain Entity representing a LaTeX/TeX text document in the Manuscripts subsystem.
 */

import { DocRanges, DocRangeVo } from './doc-range.vo';
import { WorkspaceFile } from '@/modules/manuscripts/clsi/core/ports/workspace.port';

export interface TextDocProps {
  id: string;
  projectId: string;
  path: string;
  lines: string[];
  rev: number;
  version: number;
  ranges?: DocRanges;
  hash?: string;
  sizeBytes?: number;
  inStorage?: boolean;
  storageKey?: string | null;
  deleted?: boolean;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class TextDoc {
  private _id: string;
  private _projectId: string;
  private _path: string;
  private _lines: string[];
  private _rev: number;
  private _version: number;
  private _ranges: DocRanges;
  private _hash: string;
  private _sizeBytes: number;
  private _inStorage: boolean;
  private _storageKey: string | null;
  private _deleted: boolean;
  private _deletedAt: Date | null;
  private _createdAt: Date;
  private _updatedAt: Date;

  constructor(props: TextDocProps) {
    this._id = props.id;
    this._projectId = props.projectId;
    this._path = props.path.replace(/\\/g, '/').replace(/^\/+/, '');
    this._lines = props.lines || [];
    this._rev = props.rev ?? 0;
    this._version = props.version ?? 0;
    this._ranges = DocRangeVo.normalize(props.ranges);
    this._hash = props.hash || '';
    this._sizeBytes = props.sizeBytes ?? this.calculateSizeBytes();
    this._inStorage = props.inStorage ?? false;
    this._storageKey = props.storageKey || null;
    this._deleted = props.deleted ?? false;
    this._deletedAt = props.deletedAt || null;
    this._createdAt = props.createdAt || new Date();
    this._updatedAt = props.updatedAt || new Date();
  }

  // Getters
  public get id(): string { return this._id; }
  public get projectId(): string { return this._projectId; }
  public get path(): string { return this._path; }
  public get lines(): string[] { return [...this._lines]; }
  public get rev(): number { return this._rev; }
  public get version(): number { return this._version; }
  public get ranges(): DocRanges { return this._ranges; }
  public get hash(): string { return this._hash; }
  public get sizeBytes(): number { return this._sizeBytes; }
  public get inStorage(): boolean { return this._inStorage; }
  public get storageKey(): string | null { return this._storageKey; }
  public get deleted(): boolean { return this._deleted; }
  public get deletedAt(): Date | null { return this._deletedAt; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }

  /**
   * Calculates total text byte length from the lines array plus newlines.
   */
  public calculateSizeBytes(): number {
    if (this._lines.length === 0) return 0;
    const chars = this._lines.reduce((acc, line) => acc + line.length, 0);
    return chars + Math.max(0, this._lines.length - 1);
  }

  /**
   * Joins lines into standard Unix newline format (\n).
   */
  public toRawText(): string {
    return this._lines.join('\n');
  }

  /**
   * Converts directly to WorkspaceFile format for seamless feed into CLSI compiler.
   */
  public toWorkspaceFile(): WorkspaceFile {
    return {
      path: this._path,
      content: this.toRawText(),
      hash: this._hash || undefined,
    };
  }

  /**
   * Increments the OCC revision counter.
   */
  public incrementRev(): number {
    this._rev += 1;
    return this._rev;
  }

  /**
   * Updates lines, version, and ranges.
   */
  public updateContent(
    lines: string[],
    version: number,
    ranges?: DocRanges,
    hash?: string
  ): void {
    this._lines = lines;
    this._version = version;
    if (ranges) {
      this._ranges = DocRangeVo.normalize(ranges);
    }
    if (hash) {
      this._hash = hash;
    }
    this._sizeBytes = this.calculateSizeBytes();
    this._inStorage = false;
    this._storageKey = null;
    this._updatedAt = new Date();
  }

  /**
   * Marks document as archived in Cold Storage (S3), clearing local lines from memory.
   */
  public markArchived(storageKey: string): void {
    this._inStorage = true;
    this._storageKey = storageKey;
    this._lines = [];
  }

  /**
   * Restores document lines from Cold Storage (S3).
   */
  public unarchive(lines: string[], ranges?: DocRanges): void {
    this._inStorage = false;
    this._storageKey = null;
    this._lines = lines;
    if (ranges) {
      this._ranges = DocRangeVo.normalize(ranges);
    }
    this._sizeBytes = this.calculateSizeBytes();
  }

  /**
   * Soft deletes document.
   */
  public markDeleted(): void {
    this._deleted = true;
    this._deletedAt = new Date();
  }
}
