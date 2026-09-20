export interface CompilerDiagnostic {
  file: string;
  line: number | null;
  message: string;
  context: string;
  severity: 'error' | 'warning' | 'info';
  code?: string;
  suggestion?: string;
}

interface CommonSuggestion {
  regex: RegExp;
  suggestion: string;
}

const COMMON_SUGGESTIONS: CommonSuggestion[] = [
  {
    regex: /Undefined control sequence/i,
    suggestion:
      'A command or macro is misspelled, or its package has not been imported via \\usepackage{...}.',
  },
  {
    regex: /Missing \$ inserted/i,
    suggestion:
      'A math symbol, superscript (^), or subscript (_) was used in normal text. Enclose it in $...$ or \\(...\\).',
  },
  {
    regex: /File ['"]?([^'"]+)['"]? not found/i,
    suggestion:
      'The specified file or package is missing. Check if the image or asset is uploaded and verify the filename spelling.',
  },
  {
    regex: /Emergency stop/i,
    suggestion:
      'TeX halted compilation. This usually happens when an input file is missing or a catastrophic syntax error occurred.',
  },
  {
    regex: /Extra (?:\\right|\\endgroup|\})/i,
    suggestion:
      'Unmatched delimiter: check that all brackets, braces, and \\left / \\right pairs are properly balanced.',
  },
  {
    regex: /Environment ['"]?([^'"]+)['"]? undefined/i,
    suggestion:
      'The environment does not exist. Check for typos in \\begin{...} or add the required package.',
  },
  {
    regex: /Citation ['"]?([^'"]+)['"]? on page \d+ undefined/i,
    suggestion:
      'The citation key was not found in references.bib. Verify the key in your bibliography file.',
  },
  {
    regex: /Reference ['"]?([^'"]+)['"]? on page \d+ undefined/i,
    suggestion:
      'The reference label was not found. Check that \\label{...} matches \\ref{...} and recompile to resolve cross-references.',
  },
  {
    regex: /Overfull \\hbox/i,
    suggestion:
      'Content is wider than the text margin. Consider hyphenating words or reformatting long equations.',
  },
  {
    regex: /Package hyperref Warning/i,
    suggestion:
      'Hyperref encountered an anchor or URL issue. Verify URL formatting and duplicate identifiers.',
  },
];

export function getLatexSuggestion(message: string): string | undefined {
  for (const item of COMMON_SUGGESTIONS) {
    if (item.regex.test(message)) {
      return item.suggestion;
    }
  }
  return undefined;
}

/**
 * Parses raw TeX engine logs (pdfLaTeX, XeLaTeX, LuaLaTeX) into structured CompilerDiagnostic items.
 * Handles file stack tracking, multi-line error blocks, LaTeX warnings, and Overfull/Underfull boxes.
 */
export function parseLatexLog(
  rawLog: string,
  defaultFile = 'main.tex',
): CompilerDiagnostic[] {
  if (!rawLog || typeof rawLog !== 'string') {
    return [];
  }

  const diagnostics: CompilerDiagnostic[] = [];
  const lines = rawLog.split(/\r?\n/);
  const fileStack: string[] = [defaultFile];

  const currentFile = (): string => {
    return fileStack.length > 0 ? fileStack[fileStack.length - 1] : defaultFile;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File tracking: detect (path/to/file.tex and )
    // Simple heuristic for TeX file navigation in logs
    if (line.includes('(')) {
      const fileMatch = line.match(/\((?:\.\/|\/|[a-zA-Z]:[\\/])([^\s()]+\.(?:tex|sty|cls|bbl|aux))/i);
      if (fileMatch) {
        const openedFile = fileMatch[1].replace(/\\/g, '/');
        const filename = openedFile.split('/').pop() || openedFile;
        fileStack.push(filename);
      }
    }

    if (line.includes(')') && fileStack.length > 1) {
      // Pop when closing parenthesis occurs
      const closeCount = (line.match(/\)/g) || []).length;
      const openCount = (line.match(/\(/g) || []).length;
      if (closeCount > openCount && fileStack.length > 1) {
        fileStack.pop();
      }
    }

    // 1. Detect Errors starting with '!'
    if (line.startsWith('!')) {
      const rawMessage = line.substring(1).trim();
      let errorLine: number | null = null;
      let contextSnippet = '';
      let lookaheadIdx = i + 1;

      // Look ahead up to 5 lines for 'l.<number>' and context text
      while (lookaheadIdx < lines.length && lookaheadIdx <= i + 5) {
        const nextLine = lines[lookaheadIdx];
        if (nextLine.startsWith('!')) {
          break; // Next error began
        }

        const lineMatch = nextLine.match(/^l\.(\d+)\s*(.*)$/);
        if (lineMatch) {
          errorLine = parseInt(lineMatch[1], 10);
          contextSnippet = lineMatch[2]?.trim() || '';
          break;
        } else if (nextLine.trim().length > 0 && !contextSnippet) {
          contextSnippet = nextLine.trim();
        }
        lookaheadIdx++;
      }

      diagnostics.push({
        file: currentFile(),
        line: errorLine,
        message: rawMessage,
        context: contextSnippet,
        severity: 'error',
        suggestion: getLatexSuggestion(rawMessage),
      });

      continue;
    }

    // 2. Detect LaTeX Warnings
    // Examples:
    // LaTeX Warning: Citation 'smith2020' on page 1 undefined on input line 42.
    // LaTeX Warning: Reference 'fig:arch' on page 2 undefined on input line 85.
    if (line.includes('LaTeX Warning:') || line.includes('Package ') && line.includes('Warning:')) {
      let warningMessage = line.trim();
      let warnLine: number | null = null;

      // Sometimes the warning continuation is on the next line
      if (
        i + 1 < lines.length &&
        !lines[i + 1].startsWith('LaTeX Warning:') &&
        !lines[i + 1].startsWith('!') &&
        lines[i + 1].trim().length > 0 &&
        !lines[i + 1].startsWith('(')
      ) {
        warningMessage += ' ' + lines[i + 1].trim();
      }

      const inputLineMatch = warningMessage.match(/(?:input line|lines?)\s+(\d+)/i);
      if (inputLineMatch) {
        warnLine = parseInt(inputLineMatch[1], 10);
      }

      diagnostics.push({
        file: currentFile(),
        line: warnLine,
        message: warningMessage,
        context: '',
        severity: 'warning',
        suggestion: getLatexSuggestion(warningMessage),
      });

      continue;
    }

    // 3. Detect Overfull/Underfull boxes
    // Example: Overfull \hbox (15.22pt too wide) in paragraph at lines 15--24
    if (line.startsWith('Overfull \\hbox') || line.startsWith('Underfull \\hbox')) {
      const boxMatch = line.match(/(Overfull|Underfull)\s+\\hbox\s*\(([^)]+)\)\s+in paragraph at lines?\s+(\d+)(?:--(\d+))?/i);
      let boxLine: number | null = null;
      let context = '';

      if (boxMatch) {
        boxLine = parseInt(boxMatch[3], 10);
        context = boxMatch[2]; // e.g. "15.22pt too wide" or "badness 10000"
      }

      diagnostics.push({
        file: currentFile(),
        line: boxLine,
        message: line.trim(),
        context,
        severity: 'info',
        suggestion: getLatexSuggestion(line),
      });
    }
  }

  return diagnostics;
}

/**
 * Extracts a concise, human-readable primary error summary from diagnostics.
 * Ideal for displaying in toasts or high-level error alerts.
 */
export function extractPrimaryError(diagnostics: CompilerDiagnostic[]): string | null {
  const firstError = diagnostics.find((d) => d.severity === 'error');
  if (!firstError) {
    return null;
  }

  const lineStr = firstError.line ? ` on line ${firstError.line}` : '';
  const fileStr = firstError.file ? ` in ${firstError.file}` : '';
  return `! ${firstError.message}${lineStr}${fileStr}`;
}