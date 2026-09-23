/**
 * diagnostics/core/ports/syntax-linter.port.ts
 * Outbound SPI Port for fast static linting of LaTeX source documents.
 */

import { DiagnosticItem } from '../domain/entities/diagnostic-item.entity';

export const SYNTAX_LINTER_PORT = Symbol('SYNTAX_LINTER_PORT');

export interface ISyntaxLinterPort {
  /**
   * Statically check a LaTeX source document for syntax bugs (unbalanced delimiters,
   * unclosed environments, naked math symbols, etc.) without running a TeX compiler.
   */
  lint(source: string, filename?: string): DiagnosticItem[];
}
