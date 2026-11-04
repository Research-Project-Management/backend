/**
 * modules/manuscripts/structure/domain/latex-outline.extractor.ts
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

export class LatexOutlineExtractor {
  public static cleanLatexTitle(raw: string): string {
    if (!raw) return '';
    let text = raw.trim();
    text = text.replace(/\$([^$]+)\$/g, '$1');
    text = text.replace(
      /\\(?:textbf|textit|emph|texttt|textsc|textrm|textsf|underline|mbox|hbox)\*?\s*\{([^{}]*)\}/g,
      '$1',
    );
    text = text.replace(
      /\\(?:cite[a-zA-Z]*|ref|eqref|pageref|autoref|cref|Cref|label|footnote)\*?\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g,
      '',
    );
    text = text.replace(/\\[a-zA-Z@]+\*?\s*/g, '');
    text = text.replace(/[{}]/g, '');
    text = text.replace(/~/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }

  private static extractBalancedBraces(
    str: string,
    openBraceIndex: number,
  ): { content: string; endIndex: number } | null {
    if (str[openBraceIndex] !== '{') return null;
    let depth = 1;
    let i = openBraceIndex + 1;
    while (i < str.length && depth > 0) {
      if (str[i] === '\\') {
        i += 2;
        continue;
      }
      if (str[i] === '{') depth++;
      else if (str[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) return null;
    return {
      content: str.slice(openBraceIndex + 1, i - 1),
      endIndex: i,
    };
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
      /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\s*(?:\[([^\]]*)\])?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? '';
      const lineNum = i + 1;

      // Strip unescaped % comments
      let cleanLine = rawLine;
      for (let c = 0; c < rawLine.length; c++) {
        if (rawLine[c] === '%' && (c === 0 || rawLine[c - 1] !== '\\')) {
          cleanLine = rawLine.slice(0, c);
          break;
        }
      }

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
            const extracted = this.extractBalancedBraces(cleanLine, braceIdx);
            if (extracted) {
              currentFloat.caption = this.cleanLatexTitle(extracted.content);
            }
          }
        }
        const labelMatch = cleanLine.match(/\\label\s*\{\s*([^}]+)\s*\}/);
        if (labelMatch && labelMatch[1]) {
          currentFloat.label = labelMatch[1].trim();
        }
        if (
          new RegExp(`\\\\end\\{${currentFloat.type}\\*?\\}`).test(trimmed)
        ) {
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

      // Check Beamer \begin{frame}{Title} or \frametitle{Title}
      const frameMatch = trimmed.match(
        /\\begin\{frame\}(?:\[[^\]]*\])?\s*\{([^}]*)\}|\\frametitle(?:\[[^\]]*\])?\s*\{([^}]*)\}/,
      );
      if (frameMatch) {
        const rawFrameTitle = frameMatch[1] || frameMatch[2] || '';
        const cleanFrameTitle =
          this.cleanLatexTitle(rawFrameTitle) || `Slide (line ${lineNum})`;
        entries.push({
          level: 'slide',
          title: cleanFrameTitle,
          line: lineNum,
          ...(file ? { file } : {}),
        });
      }

      // Check standard sectioning commands
      const secMatch = sectionRegex.exec(cleanLine);
      if (secMatch && secMatch[1]) {
        const level = secMatch[1] as LatexOutlineLevel;
        const starred = Boolean(secMatch[2]);
        const shortTitle = secMatch[3]
          ? this.cleanLatexTitle(secMatch[3])
          : undefined;
        const openBraceIdx =
          secMatch.index + secMatch[0].lastIndexOf('{');
        const extracted = this.extractBalancedBraces(cleanLine, openBraceIdx);
        const rawTitle = extracted
          ? extracted.content
          : cleanLine.slice(openBraceIdx + 1).replace(/\}.*$/, '');
        const title = this.cleanLatexTitle(rawTitle) || level;

        // Check for \label on same or immediate next line
        let label: string | undefined;
        const sameLineLabel = cleanLine.match(/\\label\s*\{\s*([^}]+)\s*\}/);
        if (sameLineLabel && sameLineLabel[1]) {
          label = sameLineLabel[1].trim();
        } else if (i + 1 < lines.length) {
          const nextLineLabel = (lines[i + 1] ?? '').match(
            /^\s*\\label\s*\{\s*([^}]+)\s*\}/,
          );
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

      while (
        stack.length > 0 &&
        stack[stack.length - 1].priority >= priority
      ) {
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
