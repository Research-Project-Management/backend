/**
 * diagnostics/core/domain/entities/diagnostic-item.entity.ts
 * Domain Entity modeling an individual compiler diagnostic, warning, or static lint issue.
 */

import { DiagnosticSeverityVo, DiagnosticSeverityType } from '../value-objects/diagnostic-severity.vo';
import { ErrorExplanationVo } from '../value-objects/error-explanation.vo';

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

  constructor(props: DiagnosticItemProps) {
    this.id = props.id || `diag-${Math.random().toString(36).substring(2, 10)}`;
    this.file = props.file || 'main.tex';
    this.line = typeof props.line === 'number' && !isNaN(props.line) ? props.line : null;
    this.column = typeof props.column === 'number' && !isNaN(props.column) ? props.column : null;
    this.severity =
      props.severity instanceof DiagnosticSeverityVo
        ? props.severity
        : DiagnosticSeverityVo.fromString(props.severity);
    this.message = props.message.trim();
    this.context = props.context;
    this.code = props.code;
    this.explanation = props.explanation;
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
    };
  }
}
