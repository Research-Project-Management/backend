/**
 * diagnostics/core/adapters/parser/tectonic-log.parser.ts
 * Parser for Tectonic Rust-based modern compiler outputs.
 * Parses diagnostics in format: 'error: <file>:<line>: <message>' and 'warning: ...'
 */

import { ILatexLogParserPort } from '../../ports/latex-log-parser.port';
import { DiagnosticItem } from '../../domain/entities/diagnostic-item.entity';
import { DiagnosticSeverityVo } from '../../domain/value-objects/diagnostic-severity.vo';
import { IErrorExplainerPort } from '../../ports/error-explainer.port';

export class TectonicLogParser implements ILatexLogParserPort {
  private static readonly TECTONIC_DIAGNOSTIC_REGEX =
    /^(error|warning):\s+(?:([^:\s]+):)?(?:(\d+):)?\s*(.+)/i;

  constructor(private readonly explainer?: IErrorExplainerPort) {}

  public parse(logText: string, defaultFile = 'main.tex'): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const lines = logText.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      const match = line.match(TectonicLogParser.TECTONIC_DIAGNOSTIC_REGEX);
      if (match) {
        const severityType = match[1]!.toLowerCase();
        const errorFile = match[2]?.trim() || defaultFile;
        const errorLine = match[3] ? parseInt(match[3], 10) : null;
        const message = match[4]!.trim();

        const context = lines.slice(i, Math.min(i + 3, lines.length)).join('\n');
        const explanation = this.explainer?.explain(message, context) || undefined;

        let severity: DiagnosticSeverityVo;
        if (severityType === 'error') {
          severity = DiagnosticSeverityVo.error();
        } else if (severityType === 'warning') {
          severity = DiagnosticSeverityVo.warning();
        } else {
          severity = DiagnosticSeverityVo.info();
        }

        diagnostics.push(
          new DiagnosticItem({
            file: errorFile,
            line: errorLine,
            severity,
            message,
            context,
            code: explanation?.code,
            explanation,
          })
        );
      }
    }

    return diagnostics;
  }
}
