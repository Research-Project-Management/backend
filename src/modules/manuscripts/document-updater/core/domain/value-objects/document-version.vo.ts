/**
 * document-updater/core/domain/value-objects/document-version.vo.ts
 * Value Object coordinating persistent DB revision (rev) and ephemeral in-flight sequence (version).
 */

export class DocumentVersionVo {
  private readonly _rev: number; // Persistent database OCC revision
  private readonly _inFlightSeq: number; // Monotonically increasing in-memory operation counter

  private constructor(rev: number, inFlightSeq = 0) {
    this._rev = Math.max(0, rev);
    this._inFlightSeq = Math.max(0, inFlightSeq);
  }

  public static initial(rev = 0): DocumentVersionVo {
    return new DocumentVersionVo(rev, 0);
  }

  public static of(rev: number, inFlightSeq: number): DocumentVersionVo {
    return new DocumentVersionVo(rev, inFlightSeq);
  }

  public get rev(): number {
    return this._rev;
  }

  public get inFlightSeq(): number {
    return this._inFlightSeq;
  }

  /**
   * Advances sequence counter when an in-flight operation arrives in memory.
   */
  public nextOp(): DocumentVersionVo {
    return new DocumentVersionVo(this._rev, this._inFlightSeq + 1);
  }

  /**
   * Advances persistent rev when docstore successfully commits.
   */
  public afterFlush(newRev: number): DocumentVersionVo {
    return new DocumentVersionVo(newRev, 0);
  }

  public equals(other: DocumentVersionVo): boolean {
    return this._rev === other._rev && this._inFlightSeq === other._inFlightSeq;
  }
}
