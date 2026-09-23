/**
 * diagnostics/core/ports/latex-log-parser.port.ts
 * Outbound SPI Port for parsing raw TeX compilation logs.
 */

import { DiagnosticItem } from '../domain/entities/diagnostic-item.entity';

export const LATEX_LOG_PARSER_PORT = Symbol('LATEX_LOG_PARSER_PORT');

export interface ILatexLogParserPort {
  /**
   * Parse a raw compilation log into an array of structured DiagnosticItem entities.
   * Tracks sub-file inclusions via TeX parentheses tree.
   */
  parse(logText: string, defaultFile?: string): DiagnosticItem[];
}
