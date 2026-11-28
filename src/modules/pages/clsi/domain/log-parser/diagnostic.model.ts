/**
 * modules/pages/clsi/domain/log-parser/diagnostic.model.ts
 * Domain models and TeX paren-tree path/line normalizers for compiler logs.
 */

import { SafePath } from '../path.policy';

export class LogLineVo {
  private static readonly TEX_LINE_WRAP_LENGTH = 79;
  private static readonly FRESH_RECORD_START_REGEX =
    /^(?:!|l\.\d+|LaTeX(?: Font)? Warning:|Package [\w-]+ Warning:|Class [\w-]+ Warning:|(?:Over|Under)full \\(?:h|v)box|Runaway argument|(?:[a-zA-Z]:[\\/])?(?:\.{0,2}[\\/])?[^\s:!()]+\.(?:tex|bib|sty|cls|dtx|ins):\d+:)/;

  /**
   * TeX engines hard-wrap log lines at 79 characters.
   * Recombines wrapped lines back into logical lines before parsing the TeX paren tree,
   * while preserving lines ending with '...' and stopping on fresh diagnostic headers.
   */
  public static unwrap(rawLog: string): string[] {
    const rawLines = rawLog
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');
    if (rawLines.length === 0) return [];

    const unwrapped: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      let current = rawLines[i] ?? '';
      let prevRaw = current;

      while (
        prevRaw.length === this.TEX_LINE_WRAP_LENGTH &&
        !prevRaw.endsWith('...') &&
        i + 1 < rawLines.length
      ) {
        const nextRaw = rawLines[i + 1] ?? '';
        if (!nextRaw || this.FRESH_RECORD_START_REGEX.test(nextRaw)) {
          break;
        }
        i++;
        current += nextRaw;
        prevRaw = nextRaw;
      }

      unwrapped.push(current);
    }

    return unwrapped;
  }
}

export const LOG_FILE_EXTENSION_REGEX =
  /\.(tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins)\b/i;

export function cleanNonFileParens(line: string): string {
  if (line.length > 8192) {
    return line.slice(0, 8192);
  }
  let result = line;
  let prev = '';
  let iterations = 0;
  while (result !== prev && iterations < 8) {
    prev = result;
    iterations++;
    result = result.replace(/\(([^()]*)\)/g, (fullMatch, content: string) => {
      if (LOG_FILE_EXTENSION_REGEX.test(content)) {
        return fullMatch;
      }
      return ' ';
    });
  }
  return result;
}

export function normalizeLogFilePath(
  rawPath: string,
  defaultFile: string,
): string {
  let normalized = rawPath.replace(/\\/g, '/').replace(/^\/?compile\//, '');
  const isDrivePath = /^[a-zA-Z]:\//.test(normalized);
  normalized = normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (normalized.includes('texmf') || normalized.includes('texlive')) {
    const parts = normalized.split('/');
    return parts[parts.length - 1] || defaultFile;
  }
  if (!isDrivePath && normalized) {
    const normalizedDefault = SafePath.normalizeRelPath(defaultFile);
    const lastSlash = normalizedDefault.lastIndexOf('/');
    if (lastSlash > 0) {
      const baseDir = normalizedDefault.slice(0, lastSlash);
      if (
        !normalized.startsWith(`${baseDir}/`) &&
        normalized !== normalizedDefault
      ) {
        return `${baseDir}/${normalized}`;
      }
    }
  }
  return normalized;
}

export type DiagnosticSeverityType = 'error' | 'warning' | 'info' | 'badbox';

export class DiagnosticSeverityVo {
  private constructor(public readonly value: DiagnosticSeverityType) {}

  public static error(): DiagnosticSeverityVo {
    return new DiagnosticSeverityVo('error');
  }

  public static warning(): DiagnosticSeverityVo {
    return new DiagnosticSeverityVo('warning');
  }

  public static info(): DiagnosticSeverityVo {
    return new DiagnosticSeverityVo('info');
  }

  public static badbox(): DiagnosticSeverityVo {
    return new DiagnosticSeverityVo('badbox');
  }

  public static fromString(val: string): DiagnosticSeverityVo {
    const normalized = val.trim().toLowerCase();
    switch (normalized) {
      case 'error':
        return DiagnosticSeverityVo.error();
      case 'warning':
      case 'warn':
        return DiagnosticSeverityVo.warning();
      case 'badbox':
      case 'overfull':
      case 'underfull':
        return DiagnosticSeverityVo.badbox();
      case 'info':
      default:
        return DiagnosticSeverityVo.info();
    }
  }

  public isError(): boolean {
    return this.value === 'error';
  }

  public isWarning(): boolean {
    return this.value === 'warning';
  }

  public isBadbox(): boolean {
    return this.value === 'badbox';
  }
}

export interface ErrorExplanationProps {
  code: string;
  title: string;
  explanation: string;
  commonCauses: string[];
  suggestedFix?: string;
  exampleSnippet?: string;
  documentationUrl?: string;
}

export class ErrorExplanationVo {
  public readonly code: string;
  public readonly title: string;
  public readonly explanation: string;
  public readonly commonCauses: readonly string[];
  public readonly suggestedFix?: string;
  public readonly exampleSnippet?: string;
  public readonly documentationUrl?: string;

  constructor(props: ErrorExplanationProps) {
    this.code = props.code;
    this.title = props.title;
    this.explanation = props.explanation;
    this.commonCauses = Object.freeze([...props.commonCauses]);
    this.suggestedFix = props.suggestedFix;
    this.exampleSnippet = props.exampleSnippet;
    this.documentationUrl = props.documentationUrl;
  }
}

export interface QuickFixVo {
  description: string;
  replacementText: string;
}

export type DiagnosticWarningSubtype =
  'font' | 'package' | 'citation' | 'reference' | 'badbox';

export type DiagnosticSourceType = 'tex' | 'bibtex' | 'biber' | 'system';

export interface DiagnosticItemProps {
  file: string;
  line: number | null;
  column?: number | null;
  severity: DiagnosticSeverityType | DiagnosticSeverityVo;
  category?: DiagnosticSeverityType;
  warningSubtype?: DiagnosticWarningSubtype;
  source?: DiagnosticSourceType;
  highlightCommand?: string;
  message: string;
  context?: string;
  code?: string;
  explanation?: ErrorExplanationVo;
  quickFix?: QuickFixVo;
}

export class DiagnosticItem {
  public readonly file: string;
  public readonly line: number | null;
  public readonly column: number | null;
  public readonly severity: DiagnosticSeverityVo;
  public readonly category: DiagnosticSeverityType;
  public readonly warningSubtype?: DiagnosticWarningSubtype;
  public readonly source?: DiagnosticSourceType;
  public readonly highlightCommand?: string;
  public readonly message: string;
  public readonly context?: string;
  public readonly code?: string;
  public readonly explanation?: ErrorExplanationVo;
  public readonly quickFix?: QuickFixVo;

  constructor(props: DiagnosticItemProps) {
    this.file = props.file || 'main.tex';
    this.line =
      typeof props.line === 'number' && !isNaN(props.line) ? props.line : null;
    this.column =
      typeof props.column === 'number' && !isNaN(props.column)
        ? props.column
        : null;
    this.severity =
      props.severity instanceof DiagnosticSeverityVo
        ? props.severity
        : DiagnosticSeverityVo.fromString(props.severity);
    this.category = props.category || this.severity.value;
    this.warningSubtype = props.warningSubtype;
    this.source = props.source;
    this.highlightCommand = props.highlightCommand;
    this.message = (props.message || '').trim();
    this.context = props.context;
    this.code = props.code;
    this.explanation = props.explanation;
    this.quickFix = props.quickFix;
  }
}
