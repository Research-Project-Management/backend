/**
 * modules/pages/diagnostics/domain/compile-log.analyzer.ts
 * Pure domain LaTeX compilation log analyzer (TeX Paren-Tree State Machine).
 * Zero I/O, zero NestJS imports.
 */

import {
  DiagnosticItem,
  DiagnosticSeverityVo,
  DiagnosticWarningSubtype,
  QuickFixVo,
} from './diagnostic-item.entity';
import { DiagnosticReport } from './diagnostic-report.entity';
import { LogLineVo } from './log-line';
import { InvalidLogFormatException } from './diagnostics.errors';
import {
  CompilerDiagnostic,
  ILogParser,
} from '@/modules/pages/clsi/domain/clsi.ports';
import {
  ENV_PKG_LOOKUP,
  ErrorKnowledgeBase,
  PKG_LOOKUP,
  type ErrorExplainerLike,
  type RuleDefinition,
} from './error-knowledge-base';

export { ErrorKnowledgeBase, PKG_LOOKUP, ENV_PKG_LOOKUP };
export type { ErrorExplainerLike, RuleDefinition };

export class CompileLogAnalyzer implements ILogParser {
  private static readonly LATEX_WARNING_REGEX =
    /(?:LaTeX(?:\s+Font)?|Package [\w-]+|Class [\w-]+)\s+Warning:\s*(.+)/i;

  private static readonly BADBOX_REGEX =
    /(?:Overfull|Underfull)\s+\\(?:hbox|vbox)\s*\([^)]*\)\s*(?:in paragraph\s*)?at lines?\s+(\d+)(?:--\d+)?/i;

  private static readonly FILE_LINE_ERROR_REGEX =
    /^((?:[a-zA-Z]:[\\/])?(?:\.{0,2}[\\/])?[^\s:!()]+\.(?:tex|bib|sty|cls|dtx|ins)):(\d+):\s*(.+)/i;

  private static readonly FILE_EXTENSION_REGEX =
    /\.(tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins)\b/i;

  private readonly explainer: ErrorExplainerLike;

  constructor(explainer?: ErrorExplainerLike) {
    this.explainer = explainer ?? new ErrorKnowledgeBase();
  }

  /**
   * Implements `ILogParser.parse()` for CLSI compile pipeline diagnostics.
   * Delegates to the unified TeX paren-tree state machine (`parseTexParenTreeLog`)
   * so there is a single source of truth for LaTeX log parsing.
   */
  public parse(
    logText: string,
    defaultFile = 'main.tex',
  ): CompilerDiagnostic[] {
    if (!logText || typeof logText !== 'string') return [];

    const items = this.parseTexParenTreeLog(logText, defaultFile);
    return items.map((item) => {
      const context = item.context || item.message;
      let message = item.message;
      if (item.severity.isWarning()) {
        message = message
          .replace(/\s*on input line\s+\d+\.?$/i, '')
          .replace(/\.$/, '')
          .trim();
      }
      const { code, suggestion } = this.generateSuggestion(message, context);
      const severity: 'error' | 'warning' | 'badbox' | 'info' =
        item.severity.isError()
          ? 'error'
          : item.severity.isWarning()
            ? 'warning'
            : item.severity.isBadbox()
              ? 'badbox'
              : 'info';
      const resolvedCode = code || item.code;
      const resolvedSuggestion = suggestion || item.explanation?.suggestedFix;

      return {
        file: item.file,
        line: item.line,
        ...(item.column ? { column: item.column } : {}),
        message,
        context,
        severity,
        category: item.category || severity,
        ...(item.warningSubtype ? { warningSubtype: item.warningSubtype } : {}),
        ...(resolvedCode ? { code: resolvedCode } : {}),
        ...(resolvedSuggestion ? { suggestion: resolvedSuggestion } : {}),
        ...(item.quickFix ? { quickFix: item.quickFix } : {}),
        ...(item.explanation
          ? {
              explanation: {
                title: item.explanation.title,
                whyItHappened: item.explanation.explanation,
                howToFix:
                  item.explanation.suggestedFix ||
                  item.explanation.commonCauses[0] ||
                  '',
              },
            }
          : {}),
      };
    });
  }

  private static classifyWarningSubtype(
    rawLineOrMessage: string,
  ): DiagnosticWarningSubtype | undefined {
    const text = rawLineOrMessage.toLowerCase();
    if (
      text.includes('overfull \\hbox') ||
      text.includes('underfull \\hbox') ||
      text.includes('overfull \\vbox') ||
      text.includes('underfull \\vbox')
    ) {
      return 'badbox';
    }
    if (text.includes('latex font warning')) {
      return 'font';
    }
    if (
      text.includes('citation') &&
      (text.includes('undefined') || text.includes('biber'))
    ) {
      return 'citation';
    }
    if (
      (text.includes('reference') && text.includes('undefined')) ||
      text.includes('label(s) may have changed')
    ) {
      return 'reference';
    }
    if (text.includes('package ') || text.includes('class ')) {
      return 'package';
    }
    return undefined;
  }

  private static generateQuickFix(
    message: string,
    context: string,
  ): QuickFixVo | undefined {
    const combined = `${message}\n${context}`;

    if (/undefined control sequence/i.test(combined)) {
      const cmdMatches = Array.from(combined.matchAll(/\\([a-zA-Z@]+)/g));
      for (let idx = cmdMatches.length - 1; idx >= 0; idx--) {
        const cmd = cmdMatches[idx]?.[1];
        if (cmd && PKG_LOOKUP[cmd]) {
          const pkg = PKG_LOOKUP[cmd];
          return {
            description: `Add \\usepackage{${pkg}} to preamble`,
            replacementText: `\\usepackage{${pkg}}`,
          };
        }
      }
    }

    const envUndefMatch = combined.match(
      /environment\s+[`']?([^`'\s}]+)[`']?\s+undefined/i,
    );
    if (envUndefMatch && envUndefMatch[1]) {
      const envName = envUndefMatch[1].trim();
      const pkg = ENV_PKG_LOOKUP[envName];
      if (pkg) {
        return {
          description: `Add \\usepackage{${pkg}} for \\begin{${envName}}`,
          replacementText: `\\usepackage{${pkg}}`,
        };
      }
    }

    const envMismatchMatch = combined.match(
      /\\begin\{([^}]+)\}\s*(?:on input line \d+\s*)?ended by \\end\{([^}]+)\}/i,
    );
    if (envMismatchMatch && envMismatchMatch[1] && envMismatchMatch[2]) {
      const expectedEnv = envMismatchMatch[1].trim();
      return {
        description: `Replace with \\end{${expectedEnv}}`,
        replacementText: `\\end{${expectedEnv}}`,
      };
    }

    return undefined;
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

    const explained = this.explainer?.explain(message, context);
    if (explained) {
      return {
        code: explained.code,
        suggestion: explained.suggestedFix,
      };
    }

    return {};
  }

  public analyzeLog(
    logText: string,
    defaultFile = 'main.tex',
    _engine = 'pdflatex',
  ): DiagnosticReport {
    if (typeof logText !== 'string' || logText.trim().length === 0) {
      throw new InvalidLogFormatException();
    }

    const resolvedDefaultFile = defaultFile || 'main.tex';
    const items = this.parseTexParenTreeLog(logText, resolvedDefaultFile);

    return new DiagnosticReport({
      items,
      rawLog: logText,
    });
  }

  public parseTexParenTreeLog(
    logText: string,
    defaultFile = 'main.tex',
  ): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const lines = LogLineVo.unwrap(logText);

    const parenStack: Array<{ isFile: boolean; file?: string }> = [
      { isFile: true, file: defaultFile },
    ];
    const getActiveFile = (): string => {
      for (let s = parenStack.length - 1; s >= 0; s--) {
        if (parenStack[s]?.isFile && parenStack[s]?.file) {
          return parenStack[s].file!;
        }
      }
      return defaultFile;
    };
    const scanParensLeftToRight = (text: string) => {
      let idx = 0;
      while (idx < text.length) {
        const ch = text[idx];
        if (ch === '(') {
          const rest = text.slice(idx + 1);
          const m =
            rest.match(
              /^"((?:\.{0,2}[\\/]|\/|[a-zA-Z]:[\\/]?|[a-zA-Z0-9_-]+[\\/])?[^()"]+\.(?:tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins))"(?=\s|\)|$)/i,
            ) ??
            rest.match(
              /^((?:\.{0,2}[\\/]|\/|[a-zA-Z]:[\\/]?|[a-zA-Z0-9_-]+[\\/])?[^()\s"]+\.(?:tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins))(?=\s|\)|$)/i,
            );
          if (m) {
            const candidatePath = (m[1] || m[0]).trim().replace(/^"+|"+$/g, '');
            const cleanPath = this.normalizeFilePath(
              candidatePath,
              defaultFile,
            );
            const isSystem =
              cleanPath.includes('texmf') ||
              cleanPath.includes('texlive') ||
              /\.(?:sty|cls|def|ldf|fd|cfg)$/i.test(cleanPath);
            parenStack.push({
              isFile: !isSystem,
              file: !isSystem ? cleanPath : undefined,
            });
            idx += 1 + m[0].length;
            continue;
          } else {
            parenStack.push({ isFile: false });
          }
        } else if (ch === ')') {
          if (parenStack.length > 1) {
            parenStack.pop();
          }
        }
        idx++;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const cleanedLine = CompileLogAnalyzer.cleanNonFileParens(line);

      const isDiagnosticLine =
        CompileLogAnalyzer.FILE_LINE_ERROR_REGEX.test(line) ||
        line.startsWith('!') ||
        CompileLogAnalyzer.LATEX_WARNING_REGEX.test(line) ||
        CompileLogAnalyzer.BADBOX_REGEX.test(line);

      if (!isDiagnosticLine) {
        scanParensLeftToRight(cleanedLine);
      }

      const currentFile = getActiveFile();

      const fleMatch = line.match(CompileLogAnalyzer.FILE_LINE_ERROR_REGEX);
      if (fleMatch && fleMatch[1] && fleMatch[2] && fleMatch[3]) {
        const errorFile = this.normalizeFilePath(
          fleMatch[1].trim(),
          defaultFile,
        );
        const errorLine = parseInt(fleMatch[2], 10);
        const rawMessage = fleMatch[3].trim();
        const context = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join('\n');
        const explanation =
          this.explainer?.explain(rawMessage, context) || undefined;
        const quickFix = CompileLogAnalyzer.generateQuickFix(
          rawMessage,
          context,
        );

        diagnostics.push(
          new DiagnosticItem({
            file: errorFile,
            line: errorLine,
            severity: DiagnosticSeverityVo.error(),
            category: 'error',
            message: rawMessage,
            context,
            code: explanation?.code,
            explanation,
            quickFix,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      if (line.startsWith('!')) {
        const rawMessage = line.slice(1).trim();
        let errorLine: number | null = null;
        const contextLines: string[] = [line];

        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const nextLine = lines[j] || '';
          contextLines.push(nextLine);

          const lineMatch = nextLine.match(/^l\.(\d+)(.*)/);
          if (lineMatch && lineMatch[1]) {
            errorLine = parseInt(lineMatch[1], 10);
            i = j;
            break;
          }

          if (nextLine.startsWith('!')) {
            break;
          }
        }

        const context = contextLines.join('\n');
        const explanation =
          this.explainer?.explain(rawMessage, context) || undefined;
        const quickFix = CompileLogAnalyzer.generateQuickFix(
          rawMessage,
          context,
        );

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: errorLine,
            severity: DiagnosticSeverityVo.error(),
            category: 'error',
            message: rawMessage,
            context,
            code: explanation?.code,
            explanation,
            quickFix,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      const warningMatch = line.match(CompileLogAnalyzer.LATEX_WARNING_REGEX);
      if (warningMatch && warningMatch[1]) {
        let warnMsg = warningMatch[1].trim();
        let warnLine: number | null = null;
        const initialLineMatch = line.match(/on input line\s+(\d+)\./i);
        if (initialLineMatch && initialLineMatch[1]) {
          warnLine = parseInt(initialLineMatch[1], 10);
        }
        let context = line;

        let j = i + 1;
        while (
          j < lines.length &&
          lines[j] &&
          (/^\s{2,}/.test(lines[j]) ||
            /^\([a-zA-Z0-9_-]+\)\s/.test(lines[j])) &&
          !lines[j].startsWith('!') &&
          !lines[j].match(CompileLogAnalyzer.LATEX_WARNING_REGEX) &&
          !lines[j].match(CompileLogAnalyzer.BADBOX_REGEX) &&
          !(lines[j].startsWith('(') && lines[j].includes('/'))
        ) {
          const nextL = lines[j].trim();
          const extraLineMatch = nextL.match(/on input line\s+(\d+)\./i);
          if (extraLineMatch && extraLineMatch[1]) {
            warnLine = parseInt(extraLineMatch[1], 10);
          }
          warnMsg += ' ' + nextL;
          context += '\n' + lines[j];
          scanParensLeftToRight(
            CompileLogAnalyzer.cleanNonFileParens(lines[j]),
          );
          j++;
          i = j - 1;
        }

        const explanation =
          this.explainer?.explain(warnMsg, context) || undefined;
        const warningSubtype = CompileLogAnalyzer.classifyWarningSubtype(
          `${line} ${warnMsg}`,
        );

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: warnLine,
            severity: DiagnosticSeverityVo.warning(),
            category: 'warning',
            warningSubtype,
            message: `LaTeX Warning: ${warnMsg}`,
            context,
            code: explanation?.code,
            explanation,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      // BibTeX / Biber warnings and errors
      const bibErrorMatch = line.match(
        /^(?:ERROR - BibTeX subsystem:\s*(.+)|I found no \\(?:citation|bibdata|bibstyle) commands---while reading file\s+(.+)|.*---line\s+(\d+)\s+of file\s+([^\s]+))/i,
      );
      if (bibErrorMatch) {
        const bibLine = bibErrorMatch[3]
          ? parseInt(bibErrorMatch[3], 10)
          : null;
        const bibFile = bibErrorMatch[4]
          ? this.normalizeFilePath(bibErrorMatch[4], defaultFile)
          : currentFile;
        diagnostics.push(
          new DiagnosticItem({
            file: bibFile,
            line: bibLine,
            severity: DiagnosticSeverityVo.error(),
            category: 'error',
            message: line.trim(),
            context: line,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      const biberWarnMatch = line.match(/^WARN - (.+)$/);
      if (biberWarnMatch && biberWarnMatch[1]) {
        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: null,
            severity: DiagnosticSeverityVo.warning(),
            category: 'warning',
            warningSubtype: 'citation',
            message: `Biber Warning: ${biberWarnMatch[1].trim()}`,
            context: line,
          }),
        );
        continue;
      }

      const badboxMatch = line.match(CompileLogAnalyzer.BADBOX_REGEX);
      if (badboxMatch && badboxMatch[1]) {
        const lineNum = parseInt(badboxMatch[1], 10);
        const explanation = this.explainer?.explain(line, line) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: lineNum,
            severity: DiagnosticSeverityVo.badbox(),
            category: 'badbox',
            warningSubtype: 'badbox',
            message: line.trim(),
            context: line,
            code: explanation?.code,
            explanation,
          }),
        );
      }

      if (isDiagnosticLine) {
        scanParensLeftToRight(cleanedLine);
      }
    }

    return diagnostics;
  }

  private static cleanNonFileParens(line: string): string {
    if (line.length > 8192) {
      return line.slice(0, 8192);
    }
    let result = line;
    let prev = '';
    let iterations = 0;
    while (result !== prev && iterations < 8) {
      prev = result;
      iterations++;
      result = result.replace(/\(([^()]*)\)/g, (fullMatch, content) => {
        if (CompileLogAnalyzer.FILE_EXTENSION_REGEX.test(content)) {
          return fullMatch;
        }
        return ' ';
      });
    }
    return result;
  }

  private normalizeFilePath(raw: string, defaultFile: string): string {
    let clean = raw.replace(/\\/g, '/');
    clean = clean.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (clean.includes('texmf') || clean.includes('texlive')) {
      const parts = clean.split('/');
      return parts[parts.length - 1] || defaultFile;
    }
    return clean;
  }
}

const defaultLogParser = new CompileLogAnalyzer();

export function parseLatexLog(
  logText: string,
  defaultFile = 'main.tex',
): CompilerDiagnostic[] {
  return defaultLogParser.parse(logText, defaultFile);
}
