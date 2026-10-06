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

    // 1. First remove %TC:ignore ... %TC:endignore blocks completely (TeXcount directive)
    processed = processed.replace(/%TC:ignore[\s\S]*?%TC:endignore/gi, '');

    // 2. Remove standard LaTeX comments (% to end of line, avoiding escaped \%)
    processed = processed.replace(/^%.*$/gm, '');
    processed = processed.replace(/(?<!\\)%.*$/gm, '');

    // 3. Math displayed: $$, \[\], equation, align, gather, multline, flalign, etc.
    let mathDisplayed = 0;
    const displayMathRegex =
      /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{(?:equation|align|gather|multline|flalign|alignat)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline|flalign|alignat)\*?\}/g;
    processed = processed.replace(displayMathRegex, () => {
      mathDisplayed++;
      return ' ';
    });

    // 4. Math inlines: $...$ or \(...\)
    let mathInlines = 0;
    const inlineMathRegex = /\$(?:\\\$|[^\$])+\$|\\\([\s\S]*?\\\)/g;
    processed = processed.replace(inlineMathRegex, () => {
      mathInlines++;
      return ' ';
    });

    // 5. Headers & words in headers: \section, \chapter, \subsection, etc.
    let headers = 0;
    let wordsInHeaders = 0;
    const headerRegex =
      /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}/g;
    processed = processed.replace(headerRegex, (_, title: string) => {
      headers++;
      wordsInHeaders += this.countWords(title);
      return ' ';
    });

    // 6. Captions & footnotes: Words outside text
    let wordsInCaptions = 0;
    const captionRegex = /\\caption\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;
    processed = processed.replace(captionRegex, (_, text: string) => {
      wordsInCaptions += this.countWords(text);
      return ' ';
    });

    const footnoteRegex = /\\footnote\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;
    processed = processed.replace(footnoteRegex, (_, text: string) => {
      wordsInCaptions += this.countWords(text);
      return ' ';
    });

    // 7. Floats: figure, table, algorithm
    let floats = 0;
    const floatRegex =
      /\\begin\{(?:figure|table|algorithm|table\*|figure\*)\*?\}(?:\[[^\]]*\])?/g;
    processed = processed.replace(floatRegex, () => {
      floats++;
      return ' ';
    });

    // 8. Clean environments and commands to isolate body text
    processed = processed.replace(
      /\\begin\{[^}]+\}(?:\[[^\]]*\])?|\\end\{[^}]+\}/g,
      ' ',
    );
    processed = processed.replace(
      /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/g,
      ' ',
    );
    processed = processed.replace(/\\usepackage(?:\[[^\]]*\])?\{[^}]+\}/g, ' ');
    processed = processed.replace(
      /\\(?:includegraphics|cite|ref|label|pagestyle|thispagestyle|centering|maketitle)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g,
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
