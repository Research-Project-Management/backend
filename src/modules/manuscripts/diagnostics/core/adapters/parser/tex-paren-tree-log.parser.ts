/**
 * diagnostics/core/adapters/parser/tex-paren-tree-log.parser.ts
 * Adapter delegating ILatexLogParserPort to pure domain CompileLogAnalyzer.
 */

import { ILatexLogParserPort } from '@/modules/manuscripts/diagnostics/core/ports/latex-log-parser.port';
import { DiagnosticItem } from '@/modules/manuscripts/diagnostics/core/domain/entities/diagnostic-item.entity';
import { IErrorExplainerPort } from '@/modules/manuscripts/diagnostics/core/ports/error-explainer.port';
import { CompileLogAnalyzer } from '@/modules/manuscripts/diagnostics/domain/compile-log.analyzer';

export class TexParenTreeLogParser implements ILatexLogParserPort {
  private readonly analyzer: CompileLogAnalyzer;

  constructor(private readonly explainer?: IErrorExplainerPort) {
    this.analyzer = new CompileLogAnalyzer(explainer);
  }

  public parse(logText: string, defaultFile = 'main.tex'): DiagnosticItem[] {
    return this.analyzer.parseTexParenTreeLog(logText, defaultFile);
  }
}
