/**
 * diagnostics/core/use-cases/parse-compile-log.use-case.ts
 * Inbound Use Case: Parses raw compiler logs into an enriched DiagnosticReport entity.
 */

import { ILatexLogParserPort } from '../ports/latex-log-parser.port';
import { DiagnosticReport } from '../domain/entities/diagnostic-report.entity';
import { InvalidLogFormatException } from '../domain/exceptions/invalid-log-format.exception';

export interface ParseCompileLogCommand {
  logText: string;
  defaultFile?: string;
  engine?: string;
}

export class ParseCompileLogUseCase {
  constructor(
    private readonly defaultParser: ILatexLogParserPort,
    private readonly tectonicParser?: ILatexLogParserPort
  ) {}

  public execute(command: ParseCompileLogCommand): DiagnosticReport {
    if (typeof command.logText !== 'string' || command.logText.trim().length === 0) {
      throw new InvalidLogFormatException();
    }

    const defaultFile = command.defaultFile || 'main.tex';
    const isTectonic = command.engine?.toLowerCase() === 'tectonic';

    let items = isTectonic && this.tectonicParser
      ? this.tectonicParser.parse(command.logText, defaultFile)
      : this.defaultParser.parse(command.logText, defaultFile);

    // If tectonic parser found nothing but log has TeX errors (hybrid run), fallback to default
    if (items.length === 0 && isTectonic && this.defaultParser) {
      items = this.defaultParser.parse(command.logText, defaultFile);
    }

    return new DiagnosticReport({
      items,
      rawLog: command.logText,
    });
  }
}
