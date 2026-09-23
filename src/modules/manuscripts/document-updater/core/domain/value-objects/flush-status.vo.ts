/**
 * document-updater/core/domain/value-objects/flush-status.vo.ts
 * Value Object describing the buffer flush lifecycle.
 */

export enum FlushStatusEnum {
  /** Document in-memory matches persistent storage (clean) */
  CLEAN = 'CLEAN',
  /** Document has uncommitted in-memory edits (dirty) */
  DIRTY = 'DIRTY',
  /** Document is currently actively executing a write pipeline to docstore */
  FLUSHING = 'FLUSHING',
  /** Flush failed due to concurrency collision or network failure */
  FAILED = 'FAILED',
}

export class FlushStatusVo {
  private readonly _status: FlushStatusEnum;
  private readonly _lastChangedAt: Date;

  private constructor(status: FlushStatusEnum, lastChangedAt = new Date()) {
    this._status = status;
    this._lastChangedAt = lastChangedAt;
  }

  public static clean(): FlushStatusVo {
    return new FlushStatusVo(FlushStatusEnum.CLEAN);
  }

  public static dirty(): FlushStatusVo {
    return new FlushStatusVo(FlushStatusEnum.DIRTY);
  }

  public static flushing(): FlushStatusVo {
    return new FlushStatusVo(FlushStatusEnum.FLUSHING);
  }

  public static failed(): FlushStatusVo {
    return new FlushStatusVo(FlushStatusEnum.FAILED);
  }

  public static from(status: FlushStatusEnum): FlushStatusVo {
    return new FlushStatusVo(status);
  }

  public get value(): FlushStatusEnum {
    return this._status;
  }

  public get lastChangedAt(): Date {
    return this._lastChangedAt;
  }

  public isClean(): boolean {
    return this._status === FlushStatusEnum.CLEAN;
  }

  public isDirty(): boolean {
    return this._status === FlushStatusEnum.DIRTY;
  }

  public isFlushing(): boolean {
    return this._status === FlushStatusEnum.FLUSHING;
  }
}
