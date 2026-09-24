/**
 * realtime/core/domain/value-objects/cursor-position.vo.ts
 * Value Object describing user cursor position and selection coordinates in the editor.
 */

export interface CursorPoint {
  row: number;
  column: number;
}

export interface CursorSelection {
  anchor: CursorPoint;
  head: CursorPoint;
}

export interface CursorPositionProps {
  row: number;
  column: number;
  selection?: CursorSelection | null;
}

export class CursorPositionVo {
  public readonly row: number;
  public readonly column: number;
  public readonly selection: CursorSelection | null;

  private constructor(props: CursorPositionProps) {
    this.row = Math.max(0, Math.floor(props.row));
    this.column = Math.max(0, Math.floor(props.column));
    this.selection = props.selection
      ? {
          anchor: {
            row: Math.max(0, Math.floor(props.selection.anchor.row)),
            column: Math.max(0, Math.floor(props.selection.anchor.column)),
          },
          head: {
            row: Math.max(0, Math.floor(props.selection.head.row)),
            column: Math.max(0, Math.floor(props.selection.head.column)),
          },
        }
      : null;
  }

  public static create(props: CursorPositionProps): CursorPositionVo {
    return new CursorPositionVo(props);
  }

  public toJSON(): Record<string, any> {
    return {
      row: this.row,
      column: this.column,
      selection: this.selection,
    };
  }
}
