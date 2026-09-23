/**
 * modules/manuscripts/clsi/core/adapters/artifacts/word-counter.ts
 * Counts academic words and structural elements according to Overleaf texcount rules.
 */

import { IWordCounter, WordCountStats } from '../../ports/artifacts.port';

export class TexWordCounter implements IWordCounter {
  private countWords(text: string): number {
    const cleaned = text.trim().replace(/[^\w\s-]/g, ' ');
    const words = cleaned.split(/\s+/).filter(Boolean);
    return words.length;
  }

  public count(source: string): WordCountStats {
    let processed = source;

    processed = processed.replace(/^%.*$/gm, '');
    processed = processed.replace(/(?<!\\)%.*$/gm, '');

    let mathDisplayed = 0;
    const displayMathRegex =
      /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{(?:equation|align|gather|multline)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline)\*?\}/g;
    processed = processed.replace(displayMathRegex, () => {
      mathDisplayed++;
      return ' ';
    });

    let mathInlines = 0;
    const inlineMathRegex = /\$[^$\n]+\$|\\\([\s\S]*?\\\)/g;
    processed = processed.replace(inlineMathRegex, () => {
      mathInlines++;
      return ' ';
    });

    let headers = 0;
    let wordsInHeaders = 0;
    const headerRegex =
      /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]+)\}/g;
    processed = processed.replace(headerRegex, (_, title: string) => {
      headers++;
      wordsInHeaders += this.countWords(title);
      return ' ';
    });

    let wordsInCaptions = 0;
    const captionRegex = /\\caption\*?\{([^}]+)\}/g;
    processed = processed.replace(captionRegex, (_, text: string) => {
      wordsInCaptions += this.countWords(text);
      return ' ';
    });

    let floats = 0;
    const floatRegex = /\\begin\{(?:figure|table)\*?\}(?:\[[^\]]*\])?/g;
    processed = processed.replace(floatRegex, () => {
      floats++;
      return ' ';
    });

    processed = processed.replace(
      /\\begin\{[^}]+\}(?:\[[^\]]*\])?|\\end\{[^}]+\}/g,
      ' '
    );
    processed = processed.replace(
      /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/g,
      ' '
    );
    processed = processed.replace(
      /\\usepackage(?:\[[^\]]*\])?\{[^}]+\}/g,
      ' '
    );
    processed = processed.replace(
      /\\(?:includegraphics|cite|ref|label|pagestyle|thispagestyle|centering|maketitle)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g,
      ' '
    );
    processed = processed.replace(/\[[^\]]*\]/g, ' ');
    processed = processed.replace(/\\[a-zA-Z]+\*?/g, ' ');
    processed = processed.replace(/[{}]/g, ' ');

    const wordsInText = this.countWords(processed);

    return {
      wordsInText,
      wordsInHeaders,
      wordsInCaptions,
      headers,
      floats,
      mathInlines,
      mathDisplayed,
    };
  }
}
