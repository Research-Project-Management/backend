import { Injectable, Optional, Inject } from '@nestjs/common';
import {
  CITATION_PARSER_PORT,
  ICitationParserPort,
  ParsedCitationReference,
} from '../../domain/ports/citation-parser.port';

export interface ParseCitationsCommand {
  rawCitations: string;
}

export interface ParseCitationsResult {
  references: ParsedCitationReference[];
  count: number;
}

/**
 * Command Use Case — Parse Citations via Citation Parser Port
 *
 * Clean Architecture: Depends strictly on Domain Port (ICitationParserPort)
 * without concrete GROBID client coupling.
 */
@Injectable()
export class ParseCitationsUseCase {
  constructor(
    @Optional()
    @Inject(CITATION_PARSER_PORT)
    private readonly citationParser?: ICitationParserPort,
  ) {}

  async execute(command: ParseCitationsCommand): Promise<ParseCitationsResult> {
    if (!this.citationParser) {
      return { references: [], count: 0 };
    }

    const references = await this.citationParser.processCitationList(
      command.rawCitations,
    );

    return {
      references,
      count: references.length,
    };
  }
}
