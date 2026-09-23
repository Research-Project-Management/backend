/**
 * track-changes/core/domain/value-objects/text-range.vo.ts
 * Value Object describing starting and ending coordinates of a text change span or comment selection.
 */

export interface TextRangeProps {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export class TextRangeVo {
  public readonly startLine: number;
  public readonly startCol: number;
  public readonly endLine: number;
  public readonly endCol: number;

  private constructor(props: TextRangeProps) {
    this.startLine = Math.max(0, Math.floor(props.startLine));
    this.startCol = Math.max(0, Math.floor(props.startCol));
    this.endLine = Math.max(this.startLine, Math.floor(props.endLine));
    if (this.startLine === this.endLine) {
      this.endCol = Math.max(this.startCol, Math.floor(props.endCol));
    } else {
      this.endCol = Math.max(0, Math.floor(props.endCol));
    }
  }

  public static create(props: TextRangeProps): TextRangeVo {
    return new TextRangeVo(props);
  }

  public isMultiline(): boolean {
    return this.endLine > this.startLine;
  }

  public overlaps(other: TextRangeVo): boolean {
    if (this.endLine < other.startLine || this.startLine > other.endLine) {
      return false;
    }
    if (this.endLine === other.startLine && this.endCol <= other.startCol) {
      return false;
    }
    if (this.startLine === other.endLine && this.startCol >= other.endCol) {
      return false;
    }
    return true;
  }

  public contains(other: TextRangeVo): boolean {
    const startAfter =
      this.startLine < other.startLine ||
      (this.startLine === other.startLine && this.startCol <= other.startCol);
    const endBefore =
      this.endLine > other.endLine ||
      (this.endLine === other.endLine && this.endCol >= other.endCol);
    return startAfter && endBefore;
  }

  public toJSON(): Record<string, any> {
    return {
      startLine: this.startLine,
      startCol: this.startCol,
      endLine: this.endLine,
      endCol: this.endCol,
    };
  }
}
