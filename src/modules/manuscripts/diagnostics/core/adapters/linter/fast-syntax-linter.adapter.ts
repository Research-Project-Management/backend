/**
 * diagnostics/core/adapters/linter/fast-syntax-linter.adapter.ts
 * Adapter delegating ISyntaxLinterPort to pure domain FastSyntaxLinter.
 */

import { ISyntaxLinterPort } from '@/modules/manuscripts/diagnostics/core/ports/syntax-linter.port';
import { DiagnosticItem } from '@/modules/manuscripts/diagnostics/core/domain/entities/diagnostic-item.entity';
import { IErrorExplainerPort } from '@/modules/manuscripts/diagnostics/core/ports/error-explainer.port';
import {
  FastSyntaxLinter,
  AppliedFix,
  AutoFixResult,
} from '@/modules/manuscripts/diagnostics/domain/fast-syntax.linter';

export type { AppliedFix, AutoFixResult };

export class FastSyntaxLinterAdapter implements ISyntaxLinterPort {
  private readonly linter: FastSyntaxLinter;

  constructor(private readonly explainer?: IErrorExplainerPort) {
    this.linter = new FastSyntaxLinter(explainer);
  }

  public lint(
    source: string,
    filename = 'main.tex',
    knownBibKeys?: Set<string>,
  ): DiagnosticItem[] {
    return this.linter.lint(source, filename, knownBibKeys);
  }

  public autoFix(source: string): AutoFixResult {
    return this.linter.autoFix(source);
  }
}
