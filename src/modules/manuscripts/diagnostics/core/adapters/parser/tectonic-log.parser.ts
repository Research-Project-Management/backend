/**
 * diagnostics/core/adapters/parser/tectonic-log.parser.ts
 * Adapter delegating Tectonic log parsing to pure domain CompileLogAnalyzer.
 */

import { ILatexLogParserPort } from '@/modules/manuscripts/diagnostics/core/ports/latex-log-parser.port';
import { DiagnosticItem } from '@/modules/manuscripts/diagnostics/core/domain/entities/diagnostic-item.entity';
import { IErrorExplainerPort } from '@/modules/manuscripts/diagnostics/core/ports/error-explainer.port';
import { CompileLogAnalyzer } from '@/modules/manuscripts/diagnostics/domain/compile-log.analyzer';

export class TectonicLogParser implements ILatexLogParserPort {
  private readonly analyzer: CompileLogAnalyzer;

  constructor(private readonly explainer?: IErrorExplainerPort) {
    this.analyzer = new CompileLogAnalyzer(explainer);
  }

  public parse(logText: string, defaultFile = 'main.tex'): DiagnosticItem[] {
    return this.analyzer.parseTectonicLog(logText, defaultFile);
  }
}
