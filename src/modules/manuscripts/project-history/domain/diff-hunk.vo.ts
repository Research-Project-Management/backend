/**
 * project-history/core/domain/value-objects/diff-hunk.vo.ts
 * Value Object describing line changes and word-level highlighting within a diff block.
 */

export type LineDiffType = 'added' | 'deleted' | 'unchanged';
export type WordDiffType = 'added' | 'deleted' | 'unchanged';

export interface WordDiffToken {
  type: WordDiffType;
  text: string;
}

export interface DiffLine {
  type: LineDiffType;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  words?: WordDiffToken[];
}

export interface DiffHunkProps {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  lines: DiffLine[];
}

export class DiffHunkVo {
  public readonly oldStartLine: number;
  public readonly oldLineCount: number;
  public readonly newStartLine: number;
  public readonly newLineCount: number;
  public readonly lines: DiffLine[];

  constructor(props: DiffHunkProps) {
    this.oldStartLine = props.oldStartLine;
    this.oldLineCount = props.oldLineCount;
    this.newStartLine = props.newStartLine;
    this.newLineCount = props.newLineCount;
    this.lines = props.lines;
  }

  public get header(): string {
    return `@@ -${this.oldStartLine},${this.oldLineCount} +${this.newStartLine},${this.newLineCount} @@`;
  }
}
