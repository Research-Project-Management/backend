/**
 * modules/manuscripts/clsi/domain/tex-word.counter.ts
 * Pure in-process academic word and structural element counter following Overleaf texcount rules.
 */

import {
  IWordCounter,
  WordCountFileStats,
  WordCountSection,
  WordCountStats,
} from './clsi.ports';

const CJK_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;

export class TexWordCounter implements IWordCounter {
  private countCjk(text: string): number {
    const matches = text.match(CJK_REGEX);
    return matches ? matches.length : 0;
  }

  private countWords(text: string): number {
    const withoutMathAndCites = text
      .replace(/\$(?:\\\$|[^\$])+\$|\\\([\s\S]*?\\\)/g, ' ')
      .replace(
        /\\(?:cite[a-zA-Z]*|newcite|shortcite|parencite|textcite|footcite|nocite|ref|eqref|pageref|autoref|nameref|cref|Cref|label|url)\*?(?:\[[^\]]*\])*\{[^}]*\}/g,
        ' ',
      )
      .replace(/\\[a-zA-Z]+\*?/g, ' ')
      .replace(/[{}]/g, ' ');

    const cjkCount = this.countCjk(withoutMathAndCites);
    const nonCjk = withoutMathAndCites.replace(CJK_REGEX, ' ');
    const cleaned = nonCjk.trim().replace(/[^\w\s-]/g, ' ');
    const words = cleaned.split(/\s+/).filter(Boolean);
    return words.length + cjkCount;
  }

  private extractBalancedCommandBlocks(
    input: string,
    commandPattern: string,
    onMatch: (content: string, cmdName: string, matchIndex: number) => void,
  ): string {
    const regex = new RegExp(
      `\\\\(${commandPattern})\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{`,
      'g',
    );
    let result = '';
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(input)) !== null) {
      const cmdName = match[1] || '';
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
        onMatch(inner, cmdName, match.index);
        lastIdx = i;
        regex.lastIndex = i;
      }
    }

    result += input.slice(lastIdx);
    return result;
  }

  private extractSections(source: string): WordCountSection[] {
    const lines = source.split('\n');
    const sections: Array<{
      title: string;
      level: string;
      line: number;
      startLineIdx: number;
    }> = [];
    const headingRegex =
      /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{([^}]*)\}/;

    let inIgnoreBlock = false;
    let iffalseDepth = 0;

    for (let idx = 0; idx < lines.length; idx++) {
      const rawLine = lines[idx];
      const trimmed = rawLine.trim();

      if (/^%\s*TC:ignore\b/i.test(trimmed)) {
        inIgnoreBlock = true;
        continue;
      }
      if (/^%\s*TC:endignore\b/i.test(trimmed)) {
        inIgnoreBlock = false;
        continue;
      }
      if (inIgnoreBlock) continue;

      const noComment = rawLine.replace(/(?<!\\)%.*$/, '');
      if (/\\iffalse\b/.test(noComment)) {
        iffalseDepth++;
      }
      if (iffalseDepth > 0) {
        if (/\\fi\b/.test(noComment)) {
          iffalseDepth = Math.max(0, iffalseDepth - 1);
        }
        continue;
      }

      const match = headingRegex.exec(noComment);
      if (match) {
        const level = match[1];
        const rawTitle = match[2]
          .replace(/\\[a-zA-Z]+\*?\{([^}]*)\}/g, '$1')
          .replace(/\\[a-zA-Z]+\*?/g, '')
          .replace(/[{}]/g, '')
          .trim();
        sections.push({
          title: rawTitle || `Untitled ${level}`,
          level,
          line: idx + 1,
          startLineIdx: idx,
        });
      }
    }

    if (sections.length === 0) return [];

    return sections.map((sec, i) => {
      const nextLineIdx =
        i + 1 < sections.length ? sections[i + 1].startLineIdx : lines.length;
      const sliceText = lines.slice(sec.startLineIdx, nextLineIdx).join('\n');
      const stats = this.countInternal(sliceText, 'section.tex', false, false);
      return {
        title: sec.title,
        level: sec.level,
        line: sec.line,
        words: stats.wordsInText + stats.wordsInHeaders + stats.wordsInCaptions,
      };
    });
  }

  private extractBibliographyWords(input: string): {
    cleaned: string;
    wordsInBibliography: number;
  } {
    let wordsInBibliography = 0;
    const bibEnvRegex =
      /\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/g;
    const cleaned = input.replace(bibEnvRegex, (_full, body: string) => {
      const strippedBib = body
        .replace(/\\bibitem(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
        .replace(/\\newblock\b/g, ' ');
      wordsInBibliography += this.countWords(strippedBib);
      return ' ';
    });

    // Also handle standalone \bibitem entries in .bbl files without \begin{thebibliography}
    if (wordsInBibliography === 0 && /\\bibitem\b/.test(cleaned)) {
      const strippedBbl = cleaned
        .replace(/\\bibitem(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
        .replace(/\\newblock\b/g, ' ');
      wordsInBibliography += this.countWords(strippedBbl);
      return { cleaned: ' ', wordsInBibliography };
    }

    return { cleaned, wordsInBibliography };
  }

  private countInternal(
    source: string,
    filename: string,
    includeBibOption?: boolean,
    withSections = true,
  ): WordCountStats {
    let processed = source || '';

    // Check for %TC:incbib directive in source
    const hasTcIncbib = /^%\s*TC:incbib\b/im.test(processed);
    const includeBib = Boolean(includeBibOption || hasTcIncbib);

    const sections = withSections ? this.extractSections(processed) : [];

    // Strip preamble before \begin{document} if present
    const docStartMatch = /\\begin\{document\}/.exec(processed);
    if (docStartMatch) {
      processed = processed.slice(
        docStartMatch.index + docStartMatch[0].length,
      );
    }
    const docEndMatch = /\\end\{document\}/.exec(processed);
    if (docEndMatch) {
      processed = processed.slice(0, docEndMatch.index);
    }

    // 1. Remove %TC:ignore ... %TC:endignore and \iffalse ... \fi blocks
    processed = processed.replace(/%\s*TC:ignore[\s\S]*?%\s*TC:endignore/gi, '');
    processed = processed.replace(/\\iffalse\b[\s\S]*?\\fi\b/g, '');

    // 2. Remove standard LaTeX comments (% to end of line, avoiding escaped \%)
    processed = processed.replace(/^%.*$/gm, '');
    processed = processed.replace(/(?<!\\)%.*$/gm, '');

    // 2b. Extract bibliography / \bibitem blocks
    const bibResult = this.extractBibliographyWords(processed);
    processed = bibResult.cleaned;
    const wordsInBibliography = bibResult.wordsInBibliography;

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
      'title|part|chapter|section|subsection|subsubsection|paragraph|subparagraph',
      (title) => {
        headers++;
        wordsInHeaders += this.countWords(title);
      },
    );

    // 5. Captions & footnotes
    let wordsInCaptions = 0;
    processed = this.extractBalancedCommandBlocks(
      processed,
      'caption|footnote|abstract',
      (text) => {
        wordsInCaptions += this.countWords(text);
      },
    );

    // 6. Math displayed
    let mathDisplayed = 0;
    const displayMathRegex =
      /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{(?:equation|align|gather|multline|flalign|alignat|eqnarray)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline|flalign|alignat|eqnarray)\*?\}/g;
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

    // 8. Non-prose environments (tikz, lstlisting, minted, verbatim)
    processed = processed.replace(
      /\\begin\{(?:tikzpicture|lstlisting|minted|verbatim|tabular|tabularx|longtable)\*?\}[\s\S]*?\\end\{(?:tikzpicture|lstlisting|minted|verbatim|tabular|tabularx|longtable)\*?\}/g,
      ' ',
    );

    // 9. Clean environments and commands to isolate body text
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

    const cjkCharacters = this.countCjk(source || '');
    const wordsInText = this.countWords(processed);
    const totalWords =
      wordsInText +
      wordsInHeaders +
      wordsInCaptions +
      (includeBib ? wordsInBibliography : 0);
    const normalizedBody = processed.replace(/\s+/g, ' ').trim();
    const charactersWithSpaces = normalizedBody.length;
    const charactersNoSpaces = normalizedBody.replace(/\s/g, '').length;
    const readingTimeMinutes =
      totalWords > 0 ? Math.max(1, Math.ceil(totalWords / 200)) : 0;

    const rawLines = [
      `File: ${filename || 'document.tex'}`,
      `Encoding: utf8`,
      `Words in text: ${wordsInText}`,
      `Words in headers: ${wordsInHeaders}`,
      `Words outside text (captions, etc.): ${wordsInCaptions}`,
    ];
    if (wordsInBibliography > 0) {
      rawLines.push(`Words in bibliography: ${wordsInBibliography}`);
    }
    rawLines.push(
      `Number of headers: ${headers}`,
      `Number of floats/tables/figures: ${floats}`,
      `Number of math inlines: ${mathInlines}`,
      `Number of math displayed: ${mathDisplayed}`,
      `Subcounts:`,
      `  text+headers+captions (#headers/#floats/#inlines/#displayed)`,
      `  ${wordsInText}+${wordsInHeaders}+${wordsInCaptions} (${headers}/${floats}/${mathInlines}/${mathDisplayed}) _top_`,
    );
    for (const sec of sections) {
      rawLines.push(`  ${sec.words} ${sec.level}: ${sec.title}`);
    }

    return {
      wordsInText,
      wordsInHeaders,
      wordsInCaptions,
      wordsInBibliography,
      headers,
      floats,
      mathInlines,
      mathDisplayed,
      totalWords,
      charactersWithSpaces,
      charactersNoSpaces,
      cjkCharacters,
      readingTimeMinutes,
      sections,
      rawOutput: rawLines.join('\n'),
    };
  }

  public count(
    source: string,
    filename = 'document.tex',
    options?: { includeBib?: boolean },
  ): WordCountStats {
    return this.countInternal(
      source,
      filename,
      options?.includeBib,
      true,
    );
  }

  public countProject(
    files: Record<string, string>,
    options?: { rootFile?: string; includeBib?: boolean },
  ): WordCountStats {
    const entries = Object.entries(files).filter(([filePath, content]) => {
      if (typeof content !== 'string') return false;
      const lower = filePath.toLowerCase();
      return lower.endsWith('.tex') || lower.endsWith('.bbl');
    });

    if (entries.length === 0) {
      return {
        wordsInText: 0,
        wordsInHeaders: 0,
        wordsInCaptions: 0,
        wordsInBibliography: 0,
        headers: 0,
        floats: 0,
        mathInlines: 0,
        mathDisplayed: 0,
        totalWords: 0,
        charactersWithSpaces: 0,
        charactersNoSpaces: 0,
        cjkCharacters: 0,
        readingTimeMinutes: 0,
        sections: [],
        perFileStats: [],
        rawOutput: 'Empty project (0 words)',
      };
    }

    let totalWordsInText = 0;
    let totalWordsInHeaders = 0;
    let totalWordsInCaptions = 0;
    let totalWordsInBibliography = 0;
    let totalHeaders = 0;
    let totalFloats = 0;
    let totalMathInlines = 0;
    let totalMathDisplayed = 0;
    let totalCharsWithSpaces = 0;
    let totalCharsNoSpaces = 0;
    let totalCjk = 0;
    const allSections: WordCountSection[] = [];
    const perFileStats: WordCountFileStats[] = [];

    for (const [filePath, content] of entries) {
      const cleanName = filePath.replace(/^\/+/, '');
      const isBbl = cleanName.toLowerCase().endsWith('.bbl');
      if (isBbl && !options?.includeBib) {
        continue;
      }

      const fileStats = this.countInternal(
        content,
        cleanName,
        options?.includeBib,
        true,
      );

      totalWordsInText += fileStats.wordsInText;
      totalWordsInHeaders += fileStats.wordsInHeaders;
      totalWordsInCaptions += fileStats.wordsInCaptions;
      totalWordsInBibliography += fileStats.wordsInBibliography ?? 0;
      totalHeaders += fileStats.headers;
      totalFloats += fileStats.floats;
      totalMathInlines += fileStats.mathInlines;
      totalMathDisplayed += fileStats.mathDisplayed;
      totalCharsWithSpaces += fileStats.charactersWithSpaces;
      totalCharsNoSpaces += fileStats.charactersNoSpaces;
      totalCjk += fileStats.cjkCharacters ?? 0;

      if (fileStats.sections && fileStats.sections.length > 0) {
        allSections.push(...fileStats.sections);
      }

      perFileStats.push({
        id: cleanName,
        title: cleanName.split('/').pop() || cleanName,
        path: cleanName,
        words: fileStats.totalWords,
        wordsInText: fileStats.wordsInText,
        wordsInHeaders: fileStats.wordsInHeaders,
        wordsInCaptions: fileStats.wordsInCaptions,
        wordsInBibliography: fileStats.wordsInBibliography ?? 0,
        headers: fileStats.headers,
        floats: fileStats.floats,
        math: fileStats.mathInlines + fileStats.mathDisplayed,
        mathInlines: fileStats.mathInlines,
        mathDisplayed: fileStats.mathDisplayed,
      });
    }

    const totalWords =
      totalWordsInText +
      totalWordsInHeaders +
      totalWordsInCaptions +
      (options?.includeBib ? totalWordsInBibliography : 0);
    const readingTimeMinutes =
      totalWords > 0 ? Math.max(1, Math.ceil(totalWords / 200)) : 0;

    const rawLines = [
      `Project: ${options?.rootFile || 'main.tex'} (${perFileStats.length} files)`,
      `Encoding: utf8`,
      `Words in text: ${totalWordsInText}`,
      `Words in headers: ${totalWordsInHeaders}`,
      `Words outside text (captions, etc.): ${totalWordsInCaptions}`,
    ];
    if (totalWordsInBibliography > 0) {
      rawLines.push(`Words in bibliography: ${totalWordsInBibliography}`);
    }
    rawLines.push(
      `Number of headers: ${totalHeaders}`,
      `Number of floats/tables/figures: ${totalFloats}`,
      `Number of math inlines: ${totalMathInlines}`,
      `Number of math displayed: ${totalMathDisplayed}`,
      `Subcounts:`,
      `  text+headers+captions (#headers/#floats/#inlines/#displayed)`,
      `  ${totalWordsInText}+${totalWordsInHeaders}+${totalWordsInCaptions} (${totalHeaders}/${totalFloats}/${totalMathInlines}/${totalMathDisplayed}) _total_`,
    );
    for (const pf of perFileStats) {
      rawLines.push(
        `  ${pf.wordsInText}+${pf.wordsInHeaders}+${pf.wordsInCaptions} (${pf.headers}/${pf.floats}/${pf.mathInlines}/${pf.mathDisplayed}) File: ${pf.path}`,
      );
    }

    return {
      wordsInText: totalWordsInText,
      wordsInHeaders: totalWordsInHeaders,
      wordsInCaptions: totalWordsInCaptions,
      wordsInBibliography: totalWordsInBibliography,
      headers: totalHeaders,
      floats: totalFloats,
      mathInlines: totalMathInlines,
      mathDisplayed: totalMathDisplayed,
      totalWords,
      charactersWithSpaces: totalCharsWithSpaces,
      charactersNoSpaces: totalCharsNoSpaces,
      cjkCharacters: totalCjk,
      readingTimeMinutes,
      sections: allSections,
      perFileStats,
      rawOutput: rawLines.join('\n'),
    };
  }
}
