/**
 * document-updater/core/domain/entities/in-flight-doc.entity.ts
 * Domain Aggregate Entity representing an active, in-flight document buffer.
 * Holds current hot text lines, uncommitted operation counters, and flush lifecycle state.
 */

import { DocumentVersionVo } from '../value-objects/document-version.vo';
import { FlushStatusVo, FlushStatusEnum } from '../value-objects/flush-status.vo';
import { UpdateOpVo } from '../value-objects/update-op.vo';

export interface InFlightDocProps {
  docId: string;
  projectId: string;
  lines: string[];
  version?: DocumentVersionVo;
  status?: FlushStatusVo;
  pendingOpsCount?: number;
  lastUpdateTimestamp?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class InFlightDoc {
  private readonly _docId: string;
  private readonly _projectId: string;
  private _lines: string[];
  private _version: DocumentVersionVo;
  private _status: FlushStatusVo;
  private _pendingOpsCount: number;
  private _lastUpdateTimestamp: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: InFlightDocProps) {
    this._docId = props.docId;
    this._projectId = props.projectId;
    this._lines = [...props.lines];
    this._version = props.version ?? DocumentVersionVo.initial(0);
    this._status = props.status ?? FlushStatusVo.clean();
    this._pendingOpsCount = props.pendingOpsCount ?? 0;
    this._lastUpdateTimestamp = props.lastUpdateTimestamp ?? Date.now();
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: InFlightDocProps): InFlightDoc {
    return new InFlightDoc(props);
  }

  public get docId(): string {
    return this._docId;
  }

  public get projectId(): string {
    return this._projectId;
  }

  public get lines(): string[] {
    return [...this._lines];
  }

  public get version(): DocumentVersionVo {
    return this._version;
  }

  public get rev(): number {
    return this._version.rev;
  }

  public get inFlightSeq(): number {
    return this._version.inFlightSeq;
  }

  public get status(): FlushStatusVo {
    return this._status;
  }

  public get pendingOpsCount(): number {
    return this._pendingOpsCount;
  }

  public get lastUpdateTimestamp(): number {
    return this._lastUpdateTimestamp;
  }

  public get isDirty(): boolean {
    return this._status.isDirty();
  }

  public get isFlushing(): boolean {
    return this._status.isFlushing();
  }

  public get createdAt(): Date {
    return this._createdAt;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Applies an incoming in-flight update (keystrokes / lines / splice) to the memory buffer.
   * Advances sequence counter and marks document as DIRTY.
   */
  public applyUpdate(op: UpdateOpVo): void {
    this._lines = op.applyTo(this._lines);
    this._version = this._version.nextOp();
    this._pendingOpsCount += 1;
    this._status = FlushStatusVo.dirty();
    this._lastUpdateTimestamp = Date.now();
    this._updatedAt = new Date();
  }

  /**
   * Marks document as actively flushing to docstore.
   */
  public markFlushing(): void {
    this._status = FlushStatusVo.flushing();
    this._updatedAt = new Date();
  }

  /**
   * Called upon successful persistence to docstore.
   * Updates base persistent revision, resets in-flight sequence and pending count, and marks as CLEAN.
   */
  public markFlushed(newRev: number): void {
    this._version = this._version.afterFlush(newRev);
    this._pendingOpsCount = 0;
    this._status = FlushStatusVo.clean();
    this._updatedAt = new Date();
  }

  /**
   * Marks flush operation as failed.
   */
  public markFlushFailed(): void {
    this._status = FlushStatusVo.failed();
    this._updatedAt = new Date();
  }

  /**
   * Converts in-flight lines into joined raw string.
   */
  public toRawText(): string {
    return this._lines.join('\n');
  }
}
