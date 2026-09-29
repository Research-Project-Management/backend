export const CITATION_PARSER_PORT = Symbol('CITATION_PARSER_PORT');

export interface ParsedCitationReference {
  raw: string;
  title?: string;
  authors?: Array<{ name: string; firstName?: string; lastName?: string }>;
  year?: number;
  doi?: string;
  journal?: string;
  volume?: string;
  pages?: string;
}

export interface ICitationParserPort {
  processCitationList(rawCitations: string): Promise<ParsedCitationReference[]>;
}
