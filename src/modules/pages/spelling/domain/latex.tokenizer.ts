/**
 * modules/pages/spelling/domain/latex.tokenizer.ts
 * Pure LaTeX prose tokenizer that strips comments, math, verbatim blocks, and technical arguments.
 * Zero I/O, zero NestJS imports.
 */

import { WordTokenVo } from './spelling.models';

export class LatexTokenizer {
  private static readonly TECHNICAL_ARG_COMMANDS = [
    'cite',
    'citep',
    'citet',
    'citealp',
    'citealt',
    'citeauthor',
    'citeyear',
    'newcite',
    'shortcite',
    'parencite',
    'textcite',
    'footcite',
    'smartcite',
    'autocite',
    'nocite',
    'ref',
    'pageref',
    'eqref',
    'autoref',
    'nameref',
    'cref',
    'Cref',
    'label',
    'input',
    'include',
    'subfile',
    'usepackage',
    'documentclass',
    'bibliographystyle',
    'bibliography',
    'addbibresource',
    'includegraphics',
    'url',
    'path',
    'texttt',
    'ac',
    'Ac',
    'acf',
    'acs',
    'acl',
    'acp',
    'Acp',
    'newcommand',
    'renewcommand',
    'DeclareMathOperator',
    'definecolor',
    'color',
  ];

  public tokenize(text: string): WordTokenVo[] {
    if (!text || text.trim() === '') return [];

    const lines = text.split(/\r?\n/);
    const tokens: WordTokenVo[] = [];

    let inVerbatimOrMathEnv = false;
    let ifFalseDepth = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const originalLine = lines[lineIdx];
      const lineNum = lineIdx + 1;

      const uncommentedLine = originalLine.split(/(?<!\\)%/)[0];
      if (/\\iffalse\b/.test(uncommentedLine)) {
        ifFalseDepth++;
      }
      if (ifFalseDepth > 0) {
        if (/\\fi\b/.test(uncommentedLine)) {
          ifFalseDepth = Math.max(0, ifFalseDepth - 1);
        }
        continue;
      }

      if (
        /\\begin\{(equation|align|alignat|gather|verbatim|lstlisting|minted|multline|flalign|tikzpicture)\*?\}/i.test(
          uncommentedLine,
        )
      ) {
        inVerbatimOrMathEnv = true;
      }

      if (inVerbatimOrMathEnv) {
        if (
          /\\end\{(equation|align|alignat|gather|verbatim|lstlisting|minted|multline|flalign|tikzpicture)\*?\}/i.test(
            uncommentedLine,
          )
        ) {
          inVerbatimOrMathEnv = false;
        }
        continue;
      }

      const maskedLine = this.maskLatexLine(originalLine);
      const wordRegex = /[\p{L}]+(?:['’][\p{L}]+)*/gu;
      let match: RegExpExecArray | null;

      while ((match = wordRegex.exec(maskedLine)) !== null) {
        const rawWord = match[0];
        if (rawWord.length === 1 && !/^[aiAIyYởỞýÝeEôÔ]$/u.test(rawWord)) {
          continue;
        }

        const col = match.index + 1;
        tokens.push(
          new WordTokenVo({
            word: rawWord,
            line: lineNum,
            col,
            length: rawWord.length,
          }),
        );
      }
    }

    return tokens;
  }

  private maskLatexLine(line: string): string {
    let result = line;

    for (let i = 0; i < result.length; i++) {
      if (result[i] === '%') {
        let backslashes = 0;
        let k = i - 1;
        while (k >= 0 && result[k] === '\\') {
          backslashes++;
          k--;
        }
        if (backslashes % 2 === 0) {
          result = result.slice(0, i) + ' '.repeat(result.length - i);
          break;
        }
      }
    }

    result = result.replace(/\\verb\*?([^a-zA-Z\s])([\s\S]*?)\1/g, (m) =>
      ' '.repeat(m.length),
    );
    result = result.replace(/\$\$[\s\S]*?\$\$/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\\\[[\s\S]*?\\\]/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\$(?:\\\$|[^$\n])+\$/g, (m) =>
      ' '.repeat(m.length),
    );
    result = result.replace(/\\\([^)\n]+\\\)/g, (m) => ' '.repeat(m.length));

    for (const cmd of LatexTokenizer.TECHNICAL_ARG_COMMANDS) {
      const pattern = new RegExp(
        `\\\\${cmd}\\*?(?:\\[[^\\]]*\\])*\\{[^\\}]*\\}`,
        'g',
      );
      result = result.replace(pattern, (m) => ' '.repeat(m.length));
    }

    result = result.replace(
      /\\(begin|end)\{[^}]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})*/g,
      (m) => ' '.repeat(m.length),
    );
    result = result.replace(/\\href\{[^}]+\}/g, (m) => ' '.repeat(m.length));
    result = result.replace(/https?:\/\/[^\s{}]+/g, (m) =>
      ' '.repeat(m.length),
    );
    result = result.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (m) => ' '.repeat(m.length),
    );
    result = result.replace(/\\[a-zA-Z]+\*?/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\\[&%$#_{}~^]/g, (m) => ' '.repeat(m.length));

    return result;
  }
}

export { LatexTokenizer as LatexProseTokenizer };
