/**
 * modules/manuscripts/clsi/core/adapters/artifacts/latex-log.parser.ts
 * Parses TeX compilation logs into structured diagnostics (errors, warnings, badboxes)
 * with precise file and line associations.
 */

import { CompilerDiagnostic, ILogParser } from '../../ports/artifacts.port';

export class OverleafLogParser implements ILogParser {
  private static readonly LATEX_WARNING_REGEX =
    /(?:LaTeX|Package \w+|Class \w+)\s+Warning:\s*(.+?)(?:on input line\s+(\d+)\.|\.)/i;

  private static readonly BADBOX_REGEX =
    /(?:Overfull|Underfull)\s+\\(?:hbox|vbox)\s*\([^)]*\)\s*(?:in paragraph\s*)?at lines?\s+(\d+)(?:--\d+)?/i;

  private static readonly FILE_LINE_ERROR_REGEX =
    /^(\.{0,2}\/?[^\s:!()]+\.(?:tex|bib|sty|cls|dtx|ins)):(\d+):\s*(.+)/i;

  private static readonly TECTONIC_ERROR_REGEX =
    /^error:\s*(?:([^:\s]+):(\d+):\s*)?(.+)/i;

  public parse(
    logText: string,
    defaultFile = 'main.tex',
  ): CompilerDiagnostic[] {
    const diagnostics: CompilerDiagnostic[] = [];
    const lines = logText.split('\n');
    const fileStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      // Track TeX file open / close parentheses (Overleaf latex-log-parser parity)
      const openMatches = line.matchAll(
        /\((?:\.{0,2}\/)?([^\s()"]+\.(?:tex|sty|cls|bib))/g,
      );
      for (const m of openMatches) {
        if (m[1]) {
          fileStack.push(m[1].replace(/^\.\//, ''));
        }
      }
      if (line.includes(')') && fileStack.length > 0) {
        const closeCount = (line.match(/\)/g) || []).length;
        for (let c = 0; c < Math.min(closeCount, fileStack.length); c++) {
          fileStack.pop();
        }
      }

      const activeFile = fileStack[fileStack.length - 1] || defaultFile;

      // 1. TeX -file-line-error output (filename.tex:15: error message)
      const fleMatch = line.match(OverleafLogParser.FILE_LINE_ERROR_REGEX);
      if (fleMatch && fleMatch[1] && fleMatch[2] && fleMatch[3]) {
        const errorFile = fleMatch[1].replace(/^\.\//, '').trim();
        const errorLine = parseInt(fleMatch[2], 10);
        const message = fleMatch[3].trim();
        const context = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join('\n');
        const { code, suggestion } = this.generateSuggestion(message, context);

        diagnostics.push({
          file: errorFile,
          line: errorLine,
          message,
          context,
          severity: 'error',
          code,
          suggestion,
        });
        continue;
      }

      // 2. Tectonic CLI errors (error: file:line: message)
      const tectonicMatch = line.match(OverleafLogParser.TECTONIC_ERROR_REGEX);
      if (tectonicMatch && tectonicMatch[3]) {
        const errorFile = tectonicMatch[1]?.trim() || activeFile;
        const errorLine = parseInt(tectonicMatch[2], 10);
        const message = tectonicMatch[3].trim();
        const context = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join('\n');
        const { code, suggestion } = this.generateSuggestion(message, context);

        diagnostics.push({
          file: errorFile,
          line: errorLine,
          message,
          context,
          severity: 'error',
          code,
          suggestion,
        });
        continue;
      }

      // 3. Standard TeX critical errors (! LaTeX Error: ...)
      if (line.startsWith('!')) {
        const message = line.slice(1).trim();
        let errorLine: number | null = null;
        let context = '';

        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const match = lines[j]?.match(/^l\.(\d+)/);
          if (match && match[1]) {
            errorLine = parseInt(match[1], 10);
            context = lines.slice(i, j + 2).join('\n');
            break;
          }
        }

        const resolvedContext = context || lines.slice(i, i + 3).join('\n');
        const { code, suggestion } = this.generateSuggestion(
          message,
          resolvedContext,
        );

        diagnostics.push({
          file: activeFile,
          line: errorLine,
          message,
          context: resolvedContext,
          severity: 'error',
          code,
          suggestion,
        });
        continue;
      }

      // 4. LaTeX Package / Class Warnings
      const warningMatch = line.match(OverleafLogParser.LATEX_WARNING_REGEX);
      if (warningMatch && warningMatch[1]) {
        const message = warningMatch[1].trim();
        const lineNum = warningMatch[2] ? parseInt(warningMatch[2], 10) : null;

        diagnostics.push({
          file: activeFile,
          line: lineNum,
          message: `LaTeX Warning: ${message}`,
          context: line,
          severity: 'warning',
        });
        continue;
      }

      // 5. Badboxes (Overfull / Underfull \hbox or \vbox)
      const badboxMatch = line.match(OverleafLogParser.BADBOX_REGEX);
      if (badboxMatch && badboxMatch[1]) {
        const lineNum = parseInt(badboxMatch[1], 10);
        diagnostics.push({
          file: activeFile,
          line: lineNum,
          message: line.trim(),
          context: line,
          severity: 'info',
        });
      }
    }

    return diagnostics;
  }

  private generateSuggestion(
    message: string,
    context: string,
  ): { code?: string; suggestion?: string } {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.includes('undefined control sequence')) {
      const match = context.match(/\\([a-zA-Z]+)/);
      const command = match ? `\\${match[1]}` : 'this command';
      return {
        code: 'UNDEFINED_MACRO',
        suggestion: `Command "${command}" is undefined. Check spelling or add the required \\usepackage{...}.`,
      };
    }

    if (lowerMsg.includes('missing $ inserted')) {
      return {
        code: 'MISSING_MATH_DELIMITER',
        suggestion:
          'Math characters or variables must be placed in a math environment ($...$ or \\[...\\]).',
      };
    }

    if (lowerMsg.includes('file') && lowerMsg.includes('not found')) {
      return {
        code: 'FILE_NOT_FOUND',
        suggestion:
          'File, graphic, bibliography, or package not found. Verify the file path and extension.',
      };
    }

    return {};
  }
}
