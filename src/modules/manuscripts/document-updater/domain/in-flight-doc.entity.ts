/**
 * document-updater/domain/in-flight-doc.entity.ts
 * Domain Aggregate Entity representing an active, in-flight document buffer.
 * Holds current hot text lines, uncommitted operation counters, and flush lifecycle state.
 */

import { DocumentVersionVo } from './document-version.vo';
import { FlushStatusVo } from './flush-status.vo';
import { UpdateOpVo } from './update-op.vo';

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

  public applyUpdate(op: UpdateOpVo): void {
    this._lines = op.applyTo(this._lines);
    this._version = this._version.nextOp();
    this._pendingOpsCount += 1;
    this._status = FlushStatusVo.dirty();
    this._lastUpdateTimestamp = Date.now();
    this._updatedAt = new Date();
  }

  public markFlushing(): void {
    this._status = FlushStatusVo.flushing();
    this._updatedAt = new Date();
  }

  public markFlushed(newRev: number): void {
    this._version = this._version.afterFlush(newRev);
    this._pendingOpsCount = 0;
    this._status = FlushStatusVo.clean();
    this._updatedAt = new Date();
  }

  public markFlushFailed(): void {
    this._status = FlushStatusVo.failed();
    this._updatedAt = new Date();
  }

  public toRawText(): string {
    return this._lines.join('\n');
  }
}
