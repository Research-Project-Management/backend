/**
 * modules/manuscripts/clsi/domain/tex-word.counter.ts
 * Pure in-process academic word and structural element counter following Overleaf texcount rules.
 */

import { IWordCounter, WordCountStats } from './clsi-ports';

export class TexWordCounter implements IWordCounter {
  private countWords(text: string): number {
    const withoutMathAndCites = text
      .replace(/\$(?:\\\$|[^\$])+\$|\\\([\s\S]*?\\\)/g, ' ')
      .replace(
        /\\(?:cite[a-zA-Z]*|newcite|shortcite|parencite|textcite|footcite|nocite|ref|eqref|pageref|autoref|nameref|cref|Cref|label|url)\*?(?:\[[^\]]*\])*\{[^}]*\}/g,
        ' ',
      )
      .replace(/\\[a-zA-Z]+\*?/g, ' ')
      .replace(/[{}]/g, ' ');
    const cleaned = withoutMathAndCites.trim().replace(/[^\w\s-]/g, ' ');
    const words = cleaned.split(/\s+/).filter(Boolean);
    return words.length;
  }

  private extractBalancedCommandBlocks(
    input: string,
    commandPattern: string,
    onMatch: (content: string) => void,
  ): string {
    const regex = new RegExp(
      `\\\\(?:${commandPattern})\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{`,
      'g',
    );
    let result = '';
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(input)) !== null) {
      const openBraceIdx = match.index + match[0].length - 1;
      let depth = 1;
      let i = openBraceIdx + 1;
      while (i < input.length && depth > 0) {
        if (input[i] === '\\') {
          i += 2;
          continue;
        }
        if (input[i] === '{') depth++;
        else if (input[i] === '}') depth--;
        i++;
      }

      if (depth === 0) {
        result += input.slice(lastIdx, match.index) + ' ';
        const inner = input.slice(openBraceIdx + 1, i - 1);
        onMatch(inner);
        lastIdx = i;
        regex.lastIndex = i;
      }
    }

    result += input.slice(lastIdx);
    return result;
  }

  public count(source: string): WordCountStats {
    let processed = source;

    // 1. Remove %TC:ignore ... %TC:endignore and \iffalse ... \fi blocks
    processed = processed.replace(/%TC:ignore[\s\S]*?%TC:endignore/gi, '');
    processed = processed.replace(/\\iffalse\b[\s\S]*?\\fi\b/g, '');

    // 2. Remove standard LaTeX comments (% to end of line, avoiding escaped \%)
    processed = processed.replace(/^%.*$/gm, '');
    processed = processed.replace(/(?<!\\)%.*$/gm, '');

    // 3. Floats: figure, table, algorithm
    let floats = 0;
    const floatRegex =
      /\\begin\{(?:figure|table|algorithm|table\*|figure\*)\*?\}(?:\[[^\]]*\])?/g;
    processed = processed.replace(floatRegex, () => {
      floats++;
      return ' ';
    });

    // 4. Headers & words in headers
    let headers = 0;
    let wordsInHeaders = 0;
    processed = this.extractBalancedCommandBlocks(
      processed,
      'part|chapter|section|subsection|subsubsection|paragraph|subparagraph',
      (title) => {
        headers++;
        wordsInHeaders += this.countWords(title);
      },
    );

    // 5. Captions & footnotes
    let wordsInCaptions = 0;
    processed = this.extractBalancedCommandBlocks(
      processed,
      'caption|footnote',
      (text) => {
        wordsInCaptions += this.countWords(text);
      },
    );

    // 6. Math displayed
    let mathDisplayed = 0;
    const displayMathRegex =
      /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{(?:equation|align|gather|multline|flalign|alignat)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline|flalign|alignat)\*?\}/g;
    processed = processed.replace(displayMathRegex, () => {
      mathDisplayed++;
      return ' ';
    });

    // 7. Math inlines
    let mathInlines = 0;
    const inlineMathRegex = /\$(?:\\\$|[^\$])+\$|\\\([\s\S]*?\\\)/g;
    processed = processed.replace(inlineMathRegex, () => {
      mathInlines++;
      return ' ';
    });

    // 8. Clean environments and commands to isolate body text
    processed = processed.replace(
      /\\begin\{[^}]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})*|\\end\{[^}]+\}/g,
      ' ',
    );
    processed = processed.replace(
      /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/g,
      ' ',
    );
    processed = processed.replace(/\\usepackage(?:\[[^\]]*\])?\{[^}]+\}/g, ' ');
    processed = processed.replace(
      /\\(?:includegraphics|cite[a-zA-Z]*|newcite|shortcite|parencite|textcite|footcite|nocite|ref|eqref|pageref|autoref|nameref|cref|Cref|label|input|include|subfile|bibliography|bibliographystyle|addbibresource|url|pagestyle|thispagestyle|centering|maketitle|vspace|hspace|setlength|addtolength|newcommand|renewcommand|def)\*?(?:\[[^\]]*\])*(?:\{[^}]*\})?/g,
      ' ',
    );
    processed = processed.replace(/\[[^\]]*\]/g, ' ');
    processed = processed.replace(/\\[a-zA-Z]+\*?/g, ' ');
    processed = processed.replace(/[{}]/g, ' ');

    const wordsInText = this.countWords(processed);
    const totalWords = wordsInText + wordsInHeaders + wordsInCaptions;
    const normalizedBody = processed.replace(/\s+/g, ' ').trim();
    const charactersWithSpaces = normalizedBody.length;
    const charactersNoSpaces = normalizedBody.replace(/\s/g, '').length;

    const rawOutput = [
      `File: document.tex`,
      `Encoding: utf8`,
      `Words in text: ${wordsInText}`,
      `Words in headers: ${wordsInHeaders}`,
      `Words outside text (captions, etc.): ${wordsInCaptions}`,
      `Number of headers: ${headers}`,
      `Number of floats/tables/figures: ${floats}`,
      `Number of math inlines: ${mathInlines}`,
      `Number of math displayed: ${mathDisplayed}`,
      `Subcounts:`,
      `  text+headers+captions (#headers/#floats/#inlines/#displayed)`,
      `  ${wordsInText}+${wordsInHeaders}+${wordsInCaptions} (${headers}/${floats}/${mathInlines}/${mathDisplayed}) _top_`,
    ].join('\n');

    return {
      wordsInText,
      wordsInHeaders,
      wordsInCaptions,
      headers,
      floats,
      mathInlines,
      mathDisplayed,
      totalWords,
      charactersWithSpaces,
      charactersNoSpaces,
      rawOutput,
    };
  }
}

const defaultWordCounter = new TexWordCounter();

export function countTexWords(source: string): WordCountStats {
  return defaultWordCounter.count(source);
}

export interface WordCountResponse {
  success: boolean;
  stats?: WordCountStats;
  error?: string;
}

export class WordCountUseCase {
  constructor(
    private readonly wordCounter: IWordCounter = defaultWordCounter,
  ) {}

  public execute(source: string): WordCountResponse {
    if (!source || typeof source !== 'string') {
      return {
        success: false,
        error: 'Missing or invalid source code for word counting',
      };
    }

    try {
      const stats = this.wordCounter.count(source);
      return {
        success: true,
        stats,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: (err as Error)?.message || 'Failed to calculate word count',
      };
    }
  }
}
