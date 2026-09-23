/**
 * spelling/core/adapters/tokenizer/regex-latex-tokenizer.adapter.ts
 * Adapter implementing ILatexTokenizerPort.
 * Extracts prose words from LaTeX source while masking commands, math mode,
 * arguments, and comments using space-preserving masking to guarantee exact column coordinates.
 */

import { Injectable } from '@nestjs/common';
import { ILatexTokenizerPort } from '../../ports/latex-tokenizer.port';
import { WordTokenVo } from '../../domain/value-objects/word-token.vo';

@Injectable()
export class RegexLatexTokenizerAdapter implements ILatexTokenizerPort {
  // LaTeX macros whose arguments are technical keys/paths, NOT prose text to spell-check
  private static readonly TECHNICAL_ARG_COMMANDS = [
    'cite',
    'citep',
    'citet',
    'citeauthor',
    'nocite',
    'ref',
    'pageref',
    'eqref',
    'autoref',
    'label',
    'input',
    'include',
    'usepackage',
    'documentclass',
    'bibliographystyle',
    'bibliography',
    'addbibresource',
    'includegraphics',
  ];

  public tokenize(text: string): WordTokenVo[] {
    if (!text || text.trim() === '') return [];

    const lines = text.split(/\r?\n/);
    const tokens: WordTokenVo[] = [];

    // Track multi-line environment masking (e.g. \begin{equation} ... \end{equation}, \begin{verbatim})
    let inVerbatimOrMathEnv = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const originalLine = lines[lineIdx]!;
      const lineNum = lineIdx + 1;

      // Check environment transition
      if (/\\begin\{(equation|align|gather|verbatim|lstlisting|minted|multline|flalign)\*?\}/i.test(originalLine)) {
        inVerbatimOrMathEnv = true;
      }

      if (inVerbatimOrMathEnv) {
        if (/\\end\{(equation|align|gather|verbatim|lstlisting|minted|multline|flalign)\*?\}/i.test(originalLine)) {
          inVerbatimOrMathEnv = false;
        }
        continue; // Skip entire math/verbatim block lines
      }

      // Mask line while preserving column indices
      const maskedLine = this.maskLatexLine(originalLine);

      // Extract words: matches alphabetic tokens with optional internal apostrophe or hyphen
      const wordRegex = /\b[a-zA-ZÀ-ÿ]+(?:['’][a-zA-ZÀ-ÿ]+)*\b/g;
      let match: RegExpExecArray | null;

      while ((match = wordRegex.exec(maskedLine)) !== null) {
        const rawWord = match[0];
        // Skip single-letter words other than 'a', 'i', 'A', 'I' in English
        if (rawWord.length === 1 && !/^[aiAI]$/.test(rawWord)) {
          continue;
        }

        const col = match.index + 1; // 1-indexed column
        tokens.push(
          new WordTokenVo({
            word: rawWord,
            line: lineNum,
            col,
            length: rawWord.length,
          })
        );
      }
    }

    return tokens;
  }

  /**
   * Masks comments, math formulas, URLs, emails, and LaTeX command tokens with space characters
   * so that the length of the string and position of words remain strictly unchanged.
   */
  private maskLatexLine(line: string): string {
    let result = line;

    // 1. Mask comments: % preceded by even number of backslashes to end of line
    result = result.replace(/(^|[^\\])(%.*)$/, (m, prefix, comment) => {
      return prefix + ' '.repeat(comment.length);
    });

    // 2. Mask display math: $$ ... $$ or \[ ... \]
    result = result.replace(/\$\$[\s\S]*?\$\$/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\\\[[\s\S]*?\\\]/g, (m) => ' '.repeat(m.length));

    // 3. Mask inline math: $ ... $ or \( ... \)
    result = result.replace(/\$[^$\n]+\$/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\\\([^)\n]+\\\)/g, (m) => ' '.repeat(m.length));

    // 4. Mask technical commands with arguments: \cite{key}, \label{sec:1}, \ref{eq:2}, \usepackage[opt]{pkg}
    for (const cmd of RegexLatexTokenizerAdapter.TECHNICAL_ARG_COMMANDS) {
      const pattern = new RegExp(`\\\\${cmd}\\*?(?:\\[[^\\]]*\\])?\\{[^\\}]*\\}`, 'g');
      result = result.replace(pattern, (m) => ' '.repeat(m.length));
    }

    // 5. Mask \begin{env} and \end{env} tags
    result = result.replace(/\\(begin|end)\{[^\}]+\}/g, (m) => ' '.repeat(m.length));

    // 6. Mask \href{url}{text} -> mask only the url parameter
    result = result.replace(/\\href\{[^\}]+\}/g, (m) => ' '.repeat(m.length));

    // 7. Mask URLs & emails
    result = result.replace(/https?:\/\/[^\s{}]+/g, (m) => ' '.repeat(m.length));
    result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => ' '.repeat(m.length));

    // 8. Mask remaining LaTeX command names (\section, \textbf, etc.) but NOT their brace contents
    result = result.replace(/\\[a-zA-Z]+\*?/g, (m) => ' '.repeat(m.length));

    // 9. Mask single backslash escaped characters (\&, \%, \$, \_, \#, \{, \})
    result = result.replace(/\\[&%$#_{}~^]/g, (m) => ' '.repeat(m.length));

    return result;
  }
}
