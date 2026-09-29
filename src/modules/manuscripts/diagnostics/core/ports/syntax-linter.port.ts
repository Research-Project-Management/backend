/**
 * diagnostics/core/ports/syntax-linter.port.ts
 * Outbound SPI Port for fast static linting of LaTeX source documents.
 */

import { DiagnosticItem } from '../domain/entities/diagnostic-item.entity';

export const SYNTAX_LINTER_PORT = Symbol('SYNTAX_LINTER_PORT');

export interface AutoFixOutput {
  isFixed: boolean;
  fixedSource: string;
  appliedFixes: Array<{ line: number; rule: string; description: string }>;
}

export interface ISyntaxLinterPort {
  /**
   * Statically check a LaTeX source document for syntax bugs (unbalanced delimiters,
   * unclosed environments, naked math symbols, missing citation keys, etc.) without running a TeX compiler.
   */
  lint(
    source: string,
    filename?: string,
    knownBibKeys?: Set<string>,
  ): DiagnosticItem[];

  /**
   * Pre-compile auto-fixer: Automatically repairs common syntax errors
   * (smart quotes, unescaped _, %, unclosed environments).
   */
  autoFix?(source: string): AutoFixOutput;
}
