/**
 * diagnostics/core/domain/value-objects/diagnostic-severity.vo.ts
 * Value Object representing the severity level of a compiler diagnostic or lint issue.
 */

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
