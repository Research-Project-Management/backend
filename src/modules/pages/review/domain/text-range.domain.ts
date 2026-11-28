/**
 * Value Object describing starting and ending coordinates of a text change span or comment selection.
 */

export interface TextRangeProps {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export class TextRange {
  public readonly startLine: number;
  public readonly startCol: number;
  public readonly endLine: number;
  public readonly endCol: number;

  private constructor(props: TextRangeProps) {
    this.startLine = Math.max(0, Math.floor(props.startLine));
    this.startCol = Math.max(0, Math.floor(props.startCol));
    this.endLine = Math.max(this.startLine, Math.floor(props.endLine));
    this.endCol =
      this.startLine === this.endLine
        ? Math.max(this.startCol, Math.floor(props.endCol))
        : Math.max(0, Math.floor(props.endCol));
  }

  public static create(props: TextRangeProps): TextRange {
    return new TextRange(props);
  }

  public toJSON(): TextRangeProps {
    return {
      startLine: this.startLine,
      startCol: this.startCol,
      endLine: this.endLine,
      endCol: this.endCol,
    };
  }
}
