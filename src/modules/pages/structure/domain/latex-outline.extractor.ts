/**
 * modules/pages/structure/domain/latex-outline.extractor.ts
 * Pure domain service extracting structural LaTeX outlines (headings, figures,
 * tables, Beamer slides, appendices, and abstracts) for single files or multi-file projects.
 */

export type LatexOutlineLevel =
  | 'part'
  | 'chapter'
  | 'section'
  | 'subsection'
  | 'subsubsection'
  | 'paragraph'
  | 'subparagraph'
  | 'figure'
  | 'table'
  | 'slide'
  | 'appendix'
  | 'abstract';

export interface LatexOutlineEntryDto {
  level: LatexOutlineLevel;
  title: string;
  line: number;
  file?: string;
  label?: string;
  starred?: boolean;
  shortTitle?: string;
  children?: LatexOutlineEntryDto[];
}

const HEADING_PRIORITY: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const MAX_MULTILINE_SCAN_LINES = 12;

export class LatexOutlineExtractor {
  /**
   * Returns true if the character at `index` is preceded by an odd number of backslashes.
   * Properly distinguishes `\%` (escaped) from `\\%` (line break + comment).
   */
  public static isEscaped(str: string, index: number): boolean {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) {
      backslashes++;
    }
    return backslashes % 2 === 1;
  }

  /**
   * Strips an unescaped `%` comment from a single LaTeX source line.
   */
  public static stripComment(rawLine: string): string {
    for (let c = 0; c < rawLine.length; c++) {
      if (rawLine[c] === '%' && !this.isEscaped(rawLine, c)) {
        return rawLine.slice(0, c);
      }
    }
    return rawLine;
  }

  public static cleanLatexTitle(raw: string): string {
    if (!raw) return '';
    let text = raw.trim();
    // Strip inline math delimiters while keeping content
    text = text.replace(/\$([^$]+)\$/g, '$1');
    // Remove non-visual annotation macros first
    text = text.replace(
      /\\(?:cite[a-zA-Z]*|ref|eqref|pageref|autoref|cref|Cref|label|footnote)\*?\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g,
      '',
    );
    // Unwrap nested formatting commands (e.g. \textbf{Foo \emph{Bar}})
    for (let pass = 0; pass < 6; pass++) {
      const next = text.replace(
        /\\(?:textbf|textit|emph|texttt|textsc|textrm|textsf|underline|mbox|hbox|textrm|textnormal|mathrm|mathbf|mathit|mathcal|text|texorpdfstring)\*?\s*\{([^{}]*)\}/g,
        '$1',
      );
      if (next === text) break;
      text = next;
    }
    // Unescape common LaTeX special characters before stripping unknown macros
    text = text.replace(/\\([&%_#$])/g, '$1');
    text = text.replace(/\\([{}])/g, '$1');
    text = text.replace(/\\textbackslash\b\s*/g, '\\');
    // Strip remaining LaTeX control sequences
    text = text.replace(/\\[a-zA-Z@]+\*?\s*/g, '');
    text = text.replace(/[{}]/g, '');
    text = text.replace(/~/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }

  /**
   * Extracts balanced `{...}` content starting at `openBraceIndex` on `lines[startLineIdx]`,
   * seamlessly spanning multiple lines (up to MAX_MULTILINE_SCAN_LINES) while ignoring comments.
   */
  private static extractMultiLineBalancedBraces(
    lines: string[],
    startLineIdx: number,
    openBraceIndex: number,
  ): { content: string; endLineIdx: number; endIndex: number } | null {
    const firstClean = this.stripComment(lines[startLineIdx] ?? '');
    if (firstClean[openBraceIndex] !== '{') return null;

    let depth = 1;
    let buf = '';
    const maxLine = Math.min(
      lines.length - 1,
      startLineIdx + MAX_MULTILINE_SCAN_LINES,
    );

    for (let lineIdx = startLineIdx; lineIdx <= maxLine; lineIdx++) {
      const cleanLine =
        lineIdx === startLineIdx
          ? firstClean
          : this.stripComment(lines[lineIdx] ?? '');
      const startCol = lineIdx === startLineIdx ? openBraceIndex + 1 : 0;
      if (lineIdx > startLineIdx) {
        buf += ' ';
      }

      for (let col = startCol; col < cleanLine.length; col++) {
        const ch = cleanLine[col];
        if (ch === '{' && !this.isEscaped(cleanLine, col)) {
          depth++;
          buf += ch;
        } else if (ch === '}' && !this.isEscaped(cleanLine, col)) {
          depth--;
          if (depth === 0) {
            return {
              content: buf,
              endLineIdx: lineIdx,
              endIndex: col + 1,
            };
          }
          buf += ch;
        } else {
          buf += ch;
        }
      }
    }

    return null;
  }

  public static extractFromContent(
    content: string,
    file?: string,
  ): LatexOutlineEntryDto[] {
    if (!content) return [];
    const lines = content.split('\n');
    const entries: LatexOutlineEntryDto[] = [];

    let inCommentEnv = false;
    let inVerbatimEnv = false;
    let currentFloat: {
      type: 'figure' | 'table';
      startLine: number;
      caption?: string;
      label?: string;
    } | null = null;

    const sectionRegex =
      /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\s*(?:\[([^\]]*)\])?\s*\{/g;
    const frameStartRegex =
      /\\begin\{frame\}(?:\s*<[^>]*>)?(?:\s*\[[^\]]*\])?\s*\{/;
    const frameTitleRegex =
      /\\frametitle(?:\s*<[^>]*>)?(?:\s*\[[^\]]*\])?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? '';
      const lineNum = i + 1;
      const cleanLine = this.stripComment(rawLine);
      const trimmed = cleanLine.trim();
      if (!trimmed) continue;

      if (/\\begin\{comment\}/.test(trimmed)) {
        inCommentEnv = true;
        continue;
      }
      if (/\\end\{comment\}/.test(trimmed)) {
        inCommentEnv = false;
        continue;
      }
      if (inCommentEnv) continue;

      if (/\\begin\{(?:verbatim|lstlisting|minted)\*?\}/.test(trimmed)) {
        inVerbatimEnv = true;
        continue;
      }
      if (/\\end\{(?:verbatim|lstlisting|minted)\*?\}/.test(trimmed)) {
        inVerbatimEnv = false;
        continue;
      }
      if (inVerbatimEnv) continue;

      // Track figure / table float environments
      const floatStart = trimmed.match(/\\begin\{(figure|table)\*?\}/);
      if (floatStart && floatStart[1]) {
        currentFloat = {
          type: floatStart[1] as 'figure' | 'table',
          startLine: lineNum,
        };
      }

      if (currentFloat) {
        const capIdx = cleanLine.search(/\\caption\*?\s*(?:\[[^\]]*\])?\s*\{/);
        if (capIdx !== -1) {
          const braceIdx = cleanLine.indexOf('{', capIdx);
          if (braceIdx !== -1) {
            const extracted = this.extractMultiLineBalancedBraces(
              lines,
              i,
              braceIdx,
            );
            if (extracted) {
              currentFloat.caption = this.cleanLatexTitle(extracted.content);
            }
          }
        }
        const labelMatch = cleanLine.match(/\\label\s*\{\s*([^}]+)\s*\}/);
        if (labelMatch && labelMatch[1]) {
          currentFloat.label = labelMatch[1].trim();
        }
        if (new RegExp(`\\\\end\\{${currentFloat.type}\\*?\\}`).test(trimmed)) {
          entries.push({
            level: currentFloat.type,
            title:
              currentFloat.caption ||
              currentFloat.label ||
              `${currentFloat.type === 'figure' ? 'Figure' : 'Table'} (line ${currentFloat.startLine})`,
            line: currentFloat.startLine,
            ...(file ? { file } : {}),
            ...(currentFloat.label ? { label: currentFloat.label } : {}),
          });
          currentFloat = null;
        }
      }

      // Check \appendix or \begin{appendices}
      if (/\\appendix\b|\\begin\{appendices\}/.test(trimmed)) {
        entries.push({
          level: 'appendix',
          title: 'Appendix',
          line: lineNum,
          ...(file ? { file } : {}),
        });
      }

      // Check \begin{abstract}
      if (/\\begin\{abstract\}/.test(trimmed)) {
        entries.push({
          level: 'abstract',
          title: 'Abstract',
          line: lineNum,
          ...(file ? { file } : {}),
        });
      }

      // Check Beamer \begin{frame}{Title} or \frametitle{Title} with balanced/multi-line braces
      const frameMatch =
        frameStartRegex.exec(cleanLine) ?? frameTitleRegex.exec(cleanLine);
      if (frameMatch) {
        const openBraceIdx = frameMatch.index + frameMatch[0].lastIndexOf('{');
        const extracted = this.extractMultiLineBalancedBraces(
          lines,
          i,
          openBraceIdx,
        );
        const rawFrameTitle = extracted
          ? extracted.content
          : cleanLine.slice(openBraceIdx + 1).replace(/\}.*$/, '');
        const cleanFrameTitle =
          this.cleanLatexTitle(rawFrameTitle) || `Slide (line ${lineNum})`;
        entries.push({
          level: 'slide',
          title: cleanFrameTitle,
          line: lineNum,
          ...(file ? { file } : {}),
        });
        if (extracted && extracted.endLineIdx > i) {
          i = extracted.endLineIdx;
          continue;
        }
      }

      // Check standard sectioning commands (supports multiple per line & multi-line titles)
      sectionRegex.lastIndex = 0;
      let secMatch: RegExpExecArray | null;
      let maxEndLineIdx = i;
      while ((secMatch = sectionRegex.exec(cleanLine)) !== null) {
        if (!secMatch[1]) continue;
        const level = secMatch[1] as LatexOutlineLevel;
        const starred = Boolean(secMatch[2]);
        const shortTitle = secMatch[3]
          ? this.cleanLatexTitle(secMatch[3])
          : undefined;
        const openBraceIdx = secMatch.index + secMatch[0].lastIndexOf('{');
        const extracted = this.extractMultiLineBalancedBraces(
          lines,
          i,
          openBraceIdx,
        );
        const rawTitle = extracted
          ? extracted.content
          : cleanLine.slice(openBraceIdx + 1).replace(/\}.*$/, '');
        const title = this.cleanLatexTitle(rawTitle) || level;
        const endLineIdx = extracted ? extracted.endLineIdx : i;
        if (endLineIdx > maxEndLineIdx) {
          maxEndLineIdx = endLineIdx;
        }

        // Check for \label on end line or immediate next line
        let label: string | undefined;
        const endCleanLine =
          endLineIdx === i
            ? cleanLine
            : this.stripComment(lines[endLineIdx] ?? '');
        const sameLineLabel = endCleanLine.match(/\\label\s*\{\s*([^}]+)\s*\}/);
        if (sameLineLabel && sameLineLabel[1]) {
          label = sameLineLabel[1].trim();
        } else if (endLineIdx + 1 < lines.length) {
          const nextLineLabel = this.stripComment(
            lines[endLineIdx + 1] ?? '',
          ).match(/^\s*\\label\s*\{\s*([^}]+)\s*\}/);
          if (nextLineLabel && nextLineLabel[1]) {
            label = nextLineLabel[1].trim();
          }
        }

        entries.push({
          level,
          title,
          line: lineNum,
          ...(file ? { file } : {}),
          ...(label ? { label } : {}),
          ...(starred ? { starred: true } : {}),
          ...(shortTitle ? { shortTitle } : {}),
        });

        if (extracted && extracted.endLineIdx === i) {
          sectionRegex.lastIndex = Math.max(
            sectionRegex.lastIndex,
            extracted.endIndex,
          );
        } else if (extracted && extracted.endLineIdx > i) {
          break;
        }
      }
      if (maxEndLineIdx > i) {
        i = maxEndLineIdx;
      }
    }

    return entries;
  }

  public static buildOutlineTree(
    flatEntries: LatexOutlineEntryDto[],
  ): LatexOutlineEntryDto[] {
    const root: LatexOutlineEntryDto[] = [];
    const stack: { priority: number; node: LatexOutlineEntryDto }[] = [];

    for (const item of flatEntries) {
      const node: LatexOutlineEntryDto = { ...item };
      const priority = HEADING_PRIORITY[node.level];

      if (priority === undefined) {
        if (stack.length > 0) {
          const parent = stack[stack.length - 1].node;
          if (!parent.children) parent.children = [];
          parent.children.push(node);
        } else {
          root.push(node);
        }
        continue;
      }

      while (stack.length > 0 && stack[stack.length - 1].priority >= priority) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      }

      stack.push({ priority, node });
    }

    return root;
  }
}
