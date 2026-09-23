/**
 * diagnostics/core/adapters/parser/tex-paren-tree-log.parser.ts
 * Overleaf-grade TeX Parentheses File Stack State Machine Log Parser.
 * Accurately tracks file inclusions and sub-documents across compiler runs
 * to attribute errors to their true originating files.
 */

import { ILatexLogParserPort } from '../../ports/latex-log-parser.port';
import { DiagnosticItem } from '../../domain/entities/diagnostic-item.entity';
import { DiagnosticSeverityVo } from '../../domain/value-objects/diagnostic-severity.vo';
import { LogLineVo } from '../../domain/value-objects/log-line.vo';
import { IErrorExplainerPort } from '../../ports/error-explainer.port';

export class TexParenTreeLogParser implements ILatexLogParserPort {
  private static readonly LATEX_WARNING_REGEX =
    /(?:LaTeX|Package [\w-]+|Class [\w-]+)\s+Warning:\s*(.+)/i;

  private static readonly BADBOX_REGEX =
    /(?:Overfull|Underfull)\s+\\(?:hbox|vbox)\s*\([^)]*\)\s*(?:in paragraph\s*)?at lines?\s+(\d+)(?:--\d+)?/i;

  private static readonly FILE_EXTENSION_REGEX =
    /\.(tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins)$/i;

  constructor(private readonly explainer?: IErrorExplainerPort) {}

  public parse(logText: string, defaultFile = 'main.tex'): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const lines = LogLineVo.unwrap(logText);

    const fileStack: string[] = [defaultFile];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';

      // 1. Update File Stack via TeX Parentheses state machine
      this.updateFileStack(line, fileStack, defaultFile);

      const currentFile = fileStack[fileStack.length - 1] || defaultFile;

      // 2. Critical TeX Errors (starts with '!')
      if (line.startsWith('!')) {
        const rawMessage = line.slice(1).trim();
        let errorLine: number | null = null;
        let contextLines: string[] = [line];

        // Scan ahead for 'l.<number>' line number indicator
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const nextLine = lines[j] || '';
          contextLines.push(nextLine);

          const lineMatch = nextLine.match(/^l\.(\d+)(.*)/);
          if (lineMatch && lineMatch[1]) {
            errorLine = parseInt(lineMatch[1], 10);
            i = j; // Advance outer loop past error snippet
            break;
          }

          // If another error begins, stop scanning context
          if (nextLine.startsWith('!')) {
            break;
          }
        }

        const context = contextLines.join('\n');
        const explanation = this.explainer?.explain(rawMessage, context) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: errorLine,
            severity: DiagnosticSeverityVo.error(),
            message: rawMessage,
            context,
            code: explanation?.code,
            explanation,
          })
        );
        continue;
      }

      // 3. LaTeX / Package Warnings
      const warningMatch = line.match(TexParenTreeLogParser.LATEX_WARNING_REGEX);
      if (warningMatch && warningMatch[1]) {
        let warnMsg = warningMatch[1].trim();
        let warnLine: number | null = null;
        const initialLineMatch = line.match(/on input line\s+(\d+)\./i);
        if (initialLineMatch && initialLineMatch[1]) {
          warnLine = parseInt(initialLineMatch[1], 10);
        }
        let context = line;

        // If warning continues on next line(s) before an empty line, error, or next file inclusion
        let j = i + 1;
        while (
          j < lines.length &&
          lines[j] &&
          !lines[j]!.startsWith('!') &&
          !lines[j]!.match(TexParenTreeLogParser.LATEX_WARNING_REGEX) &&
          !lines[j]!.match(TexParenTreeLogParser.BADBOX_REGEX) &&
          !(lines[j]!.startsWith('(') && lines[j]!.includes('/'))
        ) {
          const nextL = lines[j]!.trim();
          const extraLineMatch = nextL.match(/on input line\s+(\d+)\./i);
          if (extraLineMatch && extraLineMatch[1]) {
            warnLine = parseInt(extraLineMatch[1], 10);
          }
          warnMsg += ' ' + nextL;
          context += '\n' + lines[j];
          j++;
          i = j - 1;
        }

        const explanation = this.explainer?.explain(warnMsg, context) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: warnLine,
            severity: DiagnosticSeverityVo.warning(),
            message: `LaTeX Warning: ${warnMsg}`,
            context,
            code: explanation?.code,
            explanation,
          })
        );
        continue;
      }

      // 4. Badboxes (Overfull / Underfull \hbox or \vbox)
      const badboxMatch = line.match(TexParenTreeLogParser.BADBOX_REGEX);
      if (badboxMatch && badboxMatch[1]) {
        const lineNum = parseInt(badboxMatch[1], 10);
        const explanation = this.explainer?.explain(line, line) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: lineNum,
            severity: DiagnosticSeverityVo.badbox(),
            message: line.trim(),
            context: line,
            code: explanation?.code,
            explanation,
          })
        );
      }
    }

    return diagnostics;
  }

  /**
   * Tracks parentheses in TeX logs to maintain a stack of active files.
   */
  private updateFileStack(line: string, fileStack: string[], defaultFile: string): void {
    // Look for file opening markers: (./file.tex or (/path/to/file.tex or (chapters/intro.tex
    // Avoid false positives from text parentheses like (see Figure 1)
    const openFileRegex = /\((?:\.\/|\/|[a-zA-Z]:|[a-zA-Z0-9_-]+\/)?([^()\s"]+\.[a-zA-Z0-9]+)/g;

    let match: RegExpExecArray | null;
    while ((match = openFileRegex.exec(line)) !== null) {
      const candidatePath = match[0].slice(1).trim(); // remove leading '('
      if (TexParenTreeLogParser.FILE_EXTENSION_REGEX.test(candidatePath) || candidatePath.includes('/')) {
        const cleanPath = this.normalizeFilePath(candidatePath, defaultFile);
        fileStack.push(cleanPath);
      }
    }

    // Count closing parentheses that are not escaped
    // In TeX log, when an included file ends, TeX prints a lone ')' or '...)'
    const closeCount = (line.match(/\)/g) || []).length;
    for (let c = 0; c < closeCount; c++) {
      if (fileStack.length > 1) {
        fileStack.pop();
      }
    }
  }

  private normalizeFilePath(raw: string, defaultFile: string): string {
    let clean = raw.replace(/\\/g, '/');
    clean = clean.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    // If it's a system TeX Live path (e.g. /usr/share/texlive/...), keep the basename
    if (clean.includes('texmf') || clean.includes('texlive')) {
      const parts = clean.split('/');
      return parts[parts.length - 1] || defaultFile;
    }
    return clean;
  }
}
