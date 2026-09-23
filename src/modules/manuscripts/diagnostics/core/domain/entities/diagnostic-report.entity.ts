/**
 * diagnostics/core/domain/entities/diagnostic-report.entity.ts
 * Aggregate Root modeling a complete compilation or linting diagnostic report.
 */

import { DiagnosticItem } from './diagnostic-item.entity';

export interface DiagnosticReportProps {
  id?: string;
  items: DiagnosticItem[];
  rawLog?: string;
}

export class DiagnosticReport {
  public readonly id: string;
  public readonly items: readonly DiagnosticItem[];
  public readonly errorsCount: number;
  public readonly warningsCount: number;
  public readonly badboxesCount: number;
  public readonly infoCount: number;
  public readonly isSuccess: boolean;
  public readonly rawLog?: string;

  constructor(props: DiagnosticReportProps) {
    this.id = props.id || `report-${Math.random().toString(36).substring(2, 10)}`;
    this.items = Object.freeze([...props.items]);
    this.rawLog = props.rawLog;

    let errors = 0;
    let warnings = 0;
    let badboxes = 0;
    let info = 0;

    for (const item of this.items) {
      if (item.severity.isError()) errors++;
      else if (item.severity.isWarning()) warnings++;
      else if (item.severity.isBadbox()) badboxes++;
      else info++;
    }

    this.errorsCount = errors;
    this.warningsCount = warnings;
    this.badboxesCount = badboxes;
    this.infoCount = info;
    this.isSuccess = errors === 0;
  }

  public getErrors(): DiagnosticItem[] {
    return this.items.filter((item) => item.severity.isError());
  }

  public getWarnings(): DiagnosticItem[] {
    return this.items.filter((item) => item.severity.isWarning());
  }

  public getBadboxes(): DiagnosticItem[] {
    return this.items.filter((item) => item.severity.isBadbox());
  }

  public getItemsByFile(filename: string): DiagnosticItem[] {
    const norm = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    return this.items.filter((item) => {
      const itemNorm = item.file.replace(/\\/g, '/').replace(/^\/+/, '');
      return itemNorm === norm || itemNorm.endsWith(`/${norm}`);
    });
  }

  public toJSON() {
    return {
      id: this.id,
      isSuccess: this.isSuccess,
      errorsCount: this.errorsCount,
      warningsCount: this.warningsCount,
      badboxesCount: this.badboxesCount,
      infoCount: this.infoCount,
      totalCount: this.items.length,
      items: this.items.map((item) => item.toJSON()),
    };
  }
}
