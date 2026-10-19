/**
 * modules/manuscripts/docstore/domain/text-doc.entity.ts
 * Rich Domain Entity representing a LaTeX/TeX text document in the Manuscripts subsystem.
 */

import { DocRanges, DocRangeVo } from './doc-range.vo';
import { WorkspaceFile } from '@/modules/manuscripts/core';

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

  public get id(): string {
    return this._id;
  }
  public get projectId(): string {
    return this._projectId;
  }
  public get path(): string {
    return this._path;
  }
  public get lines(): string[] {
    return [...this._lines];
  }
  public get rev(): number {
    return this._rev;
  }
  public get version(): number {
    return this._version;
  }
  public get ranges(): DocRanges {
    return this._ranges;
  }
  public get hash(): string {
    return this._hash;
  }
  public get sizeBytes(): number {
    return this._sizeBytes;
  }
  public get inStorage(): boolean {
    return this._inStorage;
  }
  public get storageKey(): string | null {
    return this._storageKey;
  }
  public get deleted(): boolean {
    return this._deleted;
  }
  public get deletedAt(): Date | null {
    return this._deletedAt;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public calculateSizeBytes(): number {
    if (this._lines.length === 0) return 0;
    const bytes = this._lines.reduce(
      (acc, line) => acc + Buffer.byteLength(line, 'utf8'),
      0,
    );
    return bytes + Math.max(0, this._lines.length - 1);
  }

  public toRawText(): string {
    return this._lines.join('\n');
  }

  public toWorkspaceFile(): WorkspaceFile {
    return {
      path: this._path,
      content: this.toRawText(),
      hash: this._hash || undefined,
    };
  }

  public incrementRev(): number {
    this._rev += 1;
    return this._rev;
  }

  public updateContent(
    lines: string[],
    version: number,
    ranges?: DocRanges,
    hash?: string,
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

  public markArchived(storageKey: string): void {
    this._inStorage = true;
    this._storageKey = storageKey;
    this._lines = [];
  }

  public unarchive(lines: string[], ranges?: DocRanges): void {
    this._inStorage = false;
    this._storageKey = null;
    this._lines = lines;
    if (ranges) {
      this._ranges = DocRangeVo.normalize(ranges);
    }
    this._sizeBytes = this.calculateSizeBytes();
  }

  public markDeleted(): void {
    this._deleted = true;
    this._deletedAt = new Date();
  }
}

export interface DiffCheckResult {
  shouldUpdate: boolean;
  updateLines: boolean;
  updateVersion: boolean;
  updateRanges: boolean;
}

export class NoopDiffChecker {
  public static areLinesEqual(
    currentLines: string[],
    newLines: string[],
  ): boolean {
    if (currentLines.length !== newLines.length) return false;
    for (let i = 0; i < currentLines.length; i++) {
      if (currentLines[i] !== newLines[i]) return false;
    }
    return true;
  }

  public static checkDiff(
    currentDoc: TextDoc,
    newLines: string[],
    newVersion: number,
    newRanges?: DocRanges,
  ): DiffCheckResult {
    const updateLines = !this.areLinesEqual(currentDoc.lines, newLines);
    const updateVersion = currentDoc.version !== newVersion;
    const updateRanges =
      newRanges !== undefined &&
      !DocRangeVo.areEqual(currentDoc.ranges, newRanges);

    const shouldUpdate = updateLines || updateVersion || updateRanges;

    return {
      shouldUpdate,
      updateLines,
      updateVersion,
      updateRanges,
    };
  }
}
