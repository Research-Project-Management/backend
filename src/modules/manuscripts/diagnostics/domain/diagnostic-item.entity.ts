/**
 * diagnostics/core/domain/entities/diagnostic-item.entity.ts
 * Domain Entity modeling an individual compiler diagnostic, warning, or static lint issue.
 */

import { randomUUID } from 'crypto';

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

  public toJSON() {
    return {
      code: this.code,
      title: this.title,
      explanation: this.explanation,
      commonCauses: [...this.commonCauses],
      suggestedFix: this.suggestedFix,
      exampleSnippet: this.exampleSnippet,
      documentationUrl: this.documentationUrl,
    };
  }
}

export interface QuickFixVo {
  description: string;
  replacementText: string;
}

export interface DiagnosticItemProps {
  id?: string;
  file: string;
  line: number | null;
  column?: number | null;
  severity: DiagnosticSeverityType | DiagnosticSeverityVo;
  message: string;
  context?: string;
  code?: string;
  explanation?: ErrorExplanationVo;
  quickFix?: QuickFixVo;
}

export class DiagnosticItem {
  public readonly id: string;
  public readonly file: string;
  public readonly line: number | null;
  public readonly column: number | null;
  public readonly severity: DiagnosticSeverityVo;
  public readonly message: string;
  public readonly context?: string;
  public readonly code?: string;
  public readonly explanation?: ErrorExplanationVo;
  public readonly quickFix?: QuickFixVo;

  constructor(props: DiagnosticItemProps) {
    this.id = props.id || `diag-${randomUUID()}`;
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
    this.message = (props.message || '').trim();
    this.context = props.context;
    this.code = props.code;
    this.explanation = props.explanation;
    this.quickFix = props.quickFix;
  }

  public toJSON() {
    return {
      id: this.id,
      file: this.file,
      line: this.line,
      column: this.column,
      severity: this.severity.value,
      message: this.message,
      context: this.context,
      code: this.code,
      explanation: this.explanation?.toJSON(),
      quickFix: this.quickFix,
    };
  }
}
