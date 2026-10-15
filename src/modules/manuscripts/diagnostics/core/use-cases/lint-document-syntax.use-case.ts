/**
 * diagnostics/core/use-cases/lint-document-syntax.use-case.ts
 * Inbound Use Case: Statically lints LaTeX document source for early syntax errors.
 */

import { ISyntaxLinterPort } from '@/modules/manuscripts/diagnostics/core/ports/syntax-linter.port';
import { DiagnosticReport } from '@/modules/manuscripts/diagnostics/core/domain/entities/diagnostic-report.entity';

export interface LintDocumentSyntaxCommand {
  source: string;
  filename?: string;
  knownBibKeys?: Set<string>;
}

export class LintDocumentSyntaxUseCase {
  constructor(private readonly linter: ISyntaxLinterPort) {}

  public execute(command: LintDocumentSyntaxCommand): DiagnosticReport {
    const source = command.source ?? '';
    const filename = command.filename || 'main.tex';

    const items = this.linter.lint(source, filename, command.knownBibKeys);

    return new DiagnosticReport({
      items,
      rawLog: undefined,
    });
  }
}
