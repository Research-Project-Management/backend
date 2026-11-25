/**
 * modules/pages/clsi/domain/log-parser/bib-log.parser.ts
 * Pure domain parser for BibTeX and Biber `.blg` compilation logs.
 * Zero I/O, zero NestJS imports.
 */

import { DiagnosticItem, DiagnosticSeverityVo } from './diagnostic.model';
import type { ErrorExplainerLike } from './error.catalog';

const DEFAULT_MAX_BIB_ENTRIES = 100;

export interface BibLogParserOptions {
  maxEntries?: number;
  defaultBibFile?: string;
  explainer?: ErrorExplainerLike;
}

function normalizeBibFilePath(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
  return cleaned || fallback;
}

export class BibLogParser {
  private readonly maxEntries: number;
  private readonly defaultBibFile: string;
  private readonly explainer?: ErrorExplainerLike;

  constructor(options: BibLogParserOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_BIB_ENTRIES;
    this.defaultBibFile = options.defaultBibFile || 'references.bib';
    this.explainer = options.explainer;
  }

  public parse(blgText: string): DiagnosticItem[] {
    if (!blgText || typeof blgText !== 'string') return [];

    const normalized = blgText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const items: DiagnosticItem[] = [];
    const isBiber = /\bbiber\b/i.test(normalized.slice(0, 400));
    let activeBibFile = this.defaultBibFile;

    for (let i = 0; i < lines.length && items.length < this.maxEntries; i++) {
      const line = (lines[i] ?? '').trimEnd();
      if (!line) continue;

      const sourceMatch =
        line.match(/^Database file #\d+:\s*(.+)$/i) ??
        line.match(/Found BibTeX data source\s+['"]([^'"]+)['"]/i);
      if (sourceMatch?.[1]) {
        activeBibFile = normalizeBibFilePath(sourceMatch[1], activeBibFile);
        continue;
      }

      const biberMatch = line.match(/^\[\d+\].*>\s*(ERROR|WARN)\s*-\s*(.+)$/);
      if (biberMatch) {
        const level = biberMatch[1];
        const rawMessage = biberMatch[2].trim();
        const subsystemMatch = rawMessage.match(
          /BibTeX subsystem:[^,]*?([^/\\\s,']+\.bib),?\s*line\s*(\d+)/i,
        );
        const fileMatch =
          subsystemMatch?.[1] ??
          rawMessage.match(/file\s+['"]([^'"]+\.bib)['"]/i)?.[1] ??
          rawMessage.match(/([^\s'"]+\.bib)\b/i)?.[1];
        const lineMatch =
          subsystemMatch?.[2] ?? rawMessage.match(/\bline\s+(\d+)\b/i)?.[1];

        const filePath = fileMatch
          ? normalizeBibFilePath(fileMatch, activeBibFile)
          : activeBibFile;
        const lineNumber = lineMatch ? parseInt(lineMatch, 10) : null;
        const isError = level === 'ERROR';
        const code = isError
          ? /duplicate/i.test(rawMessage)
            ? 'BIB_DUPLICATE_KEY'
            : 'BIB_SYNTAX_ERROR'
          : /(?:could(?:\s+not|n't)|did(?:\s+not|n't))\s+(?:be\s+)?(?:find|found)|not\s+(?:be\s+)?found|undefined/i.test(
                rawMessage,
              )
            ? 'UNDEFINED_CITATION'
            : undefined;
        const explanation =
          (code ? this.explainer?.getByCode(code) : null) ??
          this.explainer?.explain(rawMessage, line) ??
          undefined;

        items.push(
          new DiagnosticItem({
            file: filePath,
            line: lineNumber,
            severity: isError
              ? DiagnosticSeverityVo.error()
              : DiagnosticSeverityVo.warning(),
            category: isError ? 'error' : 'warning',
            ...(isError ? {} : { warningSubtype: 'citation' as const }),
            source: 'biber',
            message: `Biber ${isError ? 'Error' : 'Warning'}: ${rawMessage}`,
            context: line,
            code: code || explanation?.code,
            explanation,
          }),
        );
        continue;
      }

      const repeatedMatch = line.match(
        /^Repeated entry---line\s+(\d+)\s+of\s+file\s+(.+)$/i,
      );
      if (repeatedMatch) {
        const lineNumber = parseInt(repeatedMatch[1], 10);
        const filePath = normalizeBibFilePath(repeatedMatch[2], activeBibFile);
        const nextLine = lines[i + 1] ?? '';
        const keyMatch = nextLine.match(/:?\s*@[\w-]+\{([^,\s}]+)/);
        const context = [line, nextLine, lines[i + 2] ?? '']
          .filter(Boolean)
          .join('\n');
        const message = keyMatch
          ? `Repeated BibTeX entry "${keyMatch[1]}"`
          : 'Repeated BibTeX entry';
        const explanation =
          this.explainer?.getByCode('BIB_DUPLICATE_KEY') ?? undefined;
        items.push(
          new DiagnosticItem({
            file: filePath,
            line: lineNumber,
            severity: DiagnosticSeverityVo.error(),
            category: 'error',
            source: 'bibtex',
            message,
            context,
            code: 'BIB_DUPLICATE_KEY',
            highlightCommand: keyMatch ? keyMatch[1] : undefined,
            explanation,
          }),
        );
        continue;
      }

      const lineErrorMatch = line.match(
        /^(.*?)---line\s+(\d+)\s+of\s+file\s+([^\s]+)\s*$/,
      );
      if (lineErrorMatch) {
        const rawPrefix = lineErrorMatch[1].trim();
        const lineNumber = parseInt(lineErrorMatch[2], 10);
        const filePath = normalizeBibFilePath(lineErrorMatch[3], activeBibFile);
        const blockLines: string[] = [line];
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1] ?? '';
          if (
            !nextLine.trim() ||
            nextLine.startsWith('(') ||
            (/^[^\s]/.test(nextLine) &&
              !/^I'm skipping whatever remains/i.test(nextLine))
          ) {
            break;
          }
          i++;
          blockLines.push(nextLine);
          if (nextLine.includes('skipping whatever remains')) break;
        }
        const message = rawPrefix || 'BibTeX entry syntax error';
        const code = /repeated(?:\s+bib(?:tex)?)?\s+entry/i.test(rawPrefix)
          ? 'BIB_DUPLICATE_KEY'
          : 'BIB_SYNTAX_ERROR';
        const explanation = this.explainer?.getByCode(code) ?? undefined;
        items.push(
          new DiagnosticItem({
            file: filePath,
            line: lineNumber,
            severity: DiagnosticSeverityVo.error(),
            category: 'error',
            source: 'bibtex',
            message,
            context: blockLines.join('\n'),
            code,
            explanation,
          }),
        );
        continue;
      }

      const badCrossRef = line.match(
        /^A bad cross reference---entry\s+"([^"]+)"/i,
      );
      if (badCrossRef) {
        const nextLine = (lines[i + 1] ?? '').trim();
        if (nextLine) i++;
        const context = [line, nextLine].filter(Boolean).join('\n');
        items.push(
          new DiagnosticItem({
            file: activeBibFile,
            line: null,
            severity: DiagnosticSeverityVo.error(),
            category: 'error',
            source: 'bibtex',
            message: `${line}${nextLine ? ' ' + nextLine : ''}`,
            context,
            code: 'BIB_SYNTAX_ERROR',
            explanation:
              this.explainer?.getByCode('BIB_SYNTAX_ERROR') ?? undefined,
          }),
        );
        continue;
      }

      const missingCmdMatch = line.match(
        /^I found no \\(citation|bibdata|bibstyle) commands---while reading file\s+([^\s]+)/i,
      );
      if (missingCmdMatch) {
        items.push(
          new DiagnosticItem({
            file: normalizeBibFilePath(missingCmdMatch[2], 'main.tex'),
            line: null,
            severity: DiagnosticSeverityVo.warning(),
            category: 'warning',
            warningSubtype: 'citation',
            source: 'bibtex',
            message: line,
            context: line,
            code: 'UNDEFINED_CITATION',
            explanation:
              this.explainer?.getByCode('UNDEFINED_CITATION') ?? undefined,
          }),
        );
        continue;
      }

      const warnMatch = line.match(/^Warning--(.+)$/);
      if (warnMatch) {
        const warnText = warnMatch[1].trim();
        let lineNumber: number | null = null;
        let filePath = activeBibFile;
        const contextLines: string[] = [line];

        const nextLine = (lines[i + 1] ?? '').trim();
        const locationMatch = nextLine.match(
          /^--line\s+(\d+)\s+of\s+file\s+([^\s]+)/,
        );
        if (locationMatch) {
          lineNumber = parseInt(locationMatch[1], 10);
          filePath = normalizeBibFilePath(locationMatch[2], activeBibFile);
          contextLines.push(nextLine);
          i++;
        }

        const isUndefinedCitation =
          /(?:didn't find a database entry|could not be found|couldn't find|undefined)/i.test(
            warnText,
          );
        const code = isUndefinedCitation ? 'UNDEFINED_CITATION' : undefined;
        const explanation = code
          ? (this.explainer?.getByCode(code) ?? undefined)
          : undefined;

        items.push(
          new DiagnosticItem({
            file: filePath,
            line: lineNumber,
            severity: DiagnosticSeverityVo.warning(),
            category: 'warning',
            warningSubtype: 'citation',
            source: isBiber ? 'biber' : 'bibtex',
            message: `BibTeX Warning: ${warnText}`,
            context: contextLines.join('\n'),
            code,
            explanation,
          }),
        );
      }
    }

    return items;
  }
}
