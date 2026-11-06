import { Injectable, Optional } from '@nestjs/common';
import { RecordFormat } from '@/modules/library/ingestion/types/ingestion.types';
import { BibtexParser, QueryClassifier } from './bibtex.parser';
import { RisParser } from './ris.parser';
import {
  CslParser,
  parseMedlineNbibRecords,
  parseCsvBibliographyRecords,
} from './csl.parser';
import { XmlLegacyFormatsParser } from './xml-legacy-formats.parser';
import { mapBibtexToRawRecord } from '@/modules/library/ingestion/domain/metadata-validation.policy';

export { parseMedlineNbibRecords, parseCsvBibliographyRecords };

const MAX_IDENTIFIER_LIST_ITEMS = 200;

function parsePlainTextIdentifierList(content: string): Record<string, unknown>[] {
  const lines = (content || '')
    .split(/[\r\n,;]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));
  if (lines.length === 0) return [];

  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (records.length >= MAX_IDENTIFIER_LIST_ITEMS) break;
    const classified = QueryClassifier.classify(line);
    if (classified.type === 'DOI') {
      const key = `doi:${classified.clean.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        records.push({ doi: classified.clean, citationKey: classified.clean });
      }
    } else if (classified.type === 'ARXIV') {
      const key = `arxiv:${classified.clean.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        records.push({ arxivId: classified.clean, citationKey: `arXiv:${classified.clean}` });
      }
    } else if (classified.type === 'PMID') {
      const key = `pmid:${classified.clean.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        records.push({ pmid: classified.clean, citationKey: `PMID:${classified.clean}` });
      }
    } else if (classified.type === 'ISBN') {
      const key = `isbn:${classified.clean.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        records.push({ isbn: classified.clean, citationKey: `ISBN:${classified.clean}` });
      }
    } else if (classified.type === 'URL') {
      const key = `url:${classified.clean}`;
      if (!seen.has(key)) {
        seen.add(key);
        records.push({ url: classified.clean, citationKey: classified.clean });
      }
    }
  }
  return records;
}

interface ParsedBibliographyRecordEnvelope {
  sourceName: string;
  sourceRecordId?: string;
  rawMetadata: Record<string, unknown>;
  confidenceScore: number;
}

interface IBibliographyFormatStrategy {
  readonly format: RecordFormat;
  readonly aliases?: readonly string[];
  readonly sourceName: string;
  readonly confidenceScore: number;
  matchesContent(trimmedContent: string): boolean;
  parseRecords(content: string): Promise<Record<string, unknown>[]>;
  extractRecordId?(record: Record<string, unknown>): string | undefined;
}

class BibtexFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'BIBTEX';
  readonly sourceName = 'BibTeX';
  readonly confidenceScore = 0.95;

  constructor(private readonly parser: BibtexParser) {}

  matchesContent(trimmedContent: string): boolean {
    return /^@[a-zA-Z]+\s*\{/m.test(trimmedContent);
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    const parsedList = this.parser.parse(content);
    return parsedList.map((item) => mapBibtexToRawRecord(item));
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.citationKey ?? record.doi;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class RisFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'RIS';
  readonly sourceName = 'RIS';
  readonly confidenceScore = 0.95;

  constructor(private readonly parser: RisParser) {}

  matchesContent(trimmedContent: string): boolean {
    return /^TY\s+-\s+/m.test(trimmedContent);
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    const parsedList = this.parser.parse(content);
    return parsedList;
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class ReferFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'REFER';
  readonly sourceName = 'REFER';
  readonly confidenceScore = 0.9;

  constructor(private readonly parser: RisParser) {}

  matchesContent(trimmedContent: string): boolean {
    return /^%[A-Z0-9]\s+\S/m.test(trimmedContent);
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    const parsedList = this.parser.parse(content);
    return parsedList;
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class CslJsonFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'CSL_JSON';
  readonly aliases = ['JSON', 'CSL-JSON'] as const;
  readonly sourceName = 'CSL_JSON';
  readonly confidenceScore = 0.95;

  constructor(private readonly parser: CslParser) {}

  matchesContent(trimmedContent: string): boolean {
    return trimmedContent.startsWith('[') || trimmedContent.startsWith('{');
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    const parsedList = this.parser.parse(content);
    return parsedList;
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.citationKey ?? record.doi;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class EndnoteXmlFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'ENDNOTE_XML';
  readonly sourceName = 'ENDNOTE_XML';
  readonly confidenceScore = 0.93;

  constructor(private readonly parser: XmlLegacyFormatsParser) {}

  matchesContent(trimmedContent: string): boolean {
    return (
      /<records[\s>]/i.test(trimmedContent) ||
      /<ref-type[\s>]/i.test(trimmedContent)
    );
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    return this.parser.parseEndnoteXml(content);
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey ?? record.pmid;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class ModsFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'MODS';
  readonly sourceName = 'MODS';
  readonly confidenceScore = 0.93;

  constructor(private readonly parser: XmlLegacyFormatsParser) {}

  matchesContent(trimmedContent: string): boolean {
    return /<(?:mods:)?mods(?:Collection)?[\s>]/i.test(trimmedContent);
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    return this.parser.parseModsXml(content);
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey ?? record.pmid;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class ZoteroRdfFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'ZOTERO_RDF';
  readonly aliases = ['RDF'] as const;
  readonly sourceName = 'ZOTERO_RDF';
  readonly confidenceScore = 0.93;

  constructor(private readonly parser: XmlLegacyFormatsParser) {}

  matchesContent(trimmedContent: string): boolean {
    return (
      /<rdf:RDF[\s>]/i.test(trimmedContent) ||
      /xmlns:bib=/i.test(trimmedContent)
    );
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    return this.parser.parseZoteroRdf(content);
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey ?? record.pmid;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class MedlineFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'MEDLINE';
  readonly aliases = ['NBIB', 'PUBMED'] as const;
  readonly sourceName = 'MEDLINE';
  readonly confidenceScore = 0.93;

  constructor(private readonly parser: XmlLegacyFormatsParser) {}

  matchesContent(trimmedContent: string): boolean {
    return /^(?:PMID|TI|AU|FAU|DP|JT|LID|SO)\s*-\s+/m.test(trimmedContent);
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    return this.parser.parseMedlineNbib(content);
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey ?? record.pmid;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

class CsvFormatStrategy implements IBibliographyFormatStrategy {
  readonly format: RecordFormat = 'CSV';
  readonly sourceName = 'CSV';
  readonly confidenceScore = 0.93;

  constructor(private readonly parser: XmlLegacyFormatsParser) {}

  matchesContent(trimmedContent: string): boolean {
    return /^"?(?:Item Type|Title|Author|Authors|Publication Title|DOI|Year|Publication Year)"?\s*,/i.test(
      trimmedContent,
    );
  }

  async parseRecords(content: string): Promise<Record<string, unknown>[]> {
    return this.parser.parseCsvBibliography(content);
  }

  extractRecordId(record: Record<string, unknown>): string | undefined {
    const key = record.doi ?? record.citationKey ?? record.pmid;
    return typeof key === 'string' && key.trim() ? key : undefined;
  }
}

@Injectable()
export class BibliographyFormatRegistry {
  private readonly strategies: readonly IBibliographyFormatStrategy[];
  private readonly strategyByFormat = new Map<
    string,
    IBibliographyFormatStrategy
  >();
  private readonly xmlLegacyParser: XmlLegacyFormatsParser;

  constructor(
    @Optional() bibtexParser?: BibtexParser,
    @Optional() risParser?: RisParser,
    @Optional() cslParser?: CslParser,
    @Optional() xmlLegacyParser?: XmlLegacyFormatsParser,
  ) {
    const bibtex = bibtexParser ?? new BibtexParser();
    const ris = risParser ?? new RisParser();
    const csl = cslParser ?? new CslParser();
    this.xmlLegacyParser = xmlLegacyParser ?? new XmlLegacyFormatsParser();

    this.strategies = [
      new BibtexFormatStrategy(bibtex),
      new RisFormatStrategy(ris),
      new CslJsonFormatStrategy(csl),
      new ModsFormatStrategy(this.xmlLegacyParser),
      new ZoteroRdfFormatStrategy(this.xmlLegacyParser),
      new EndnoteXmlFormatStrategy(this.xmlLegacyParser),
      new MedlineFormatStrategy(this.xmlLegacyParser),
      new CsvFormatStrategy(this.xmlLegacyParser),
      new ReferFormatStrategy(ris),
    ];

    for (const strategy of this.strategies) {
      this.strategyByFormat.set(strategy.format.toUpperCase(), strategy);
      for (const alias of strategy.aliases ?? []) {
        this.strategyByFormat.set(alias.toUpperCase(), strategy);
      }
    }
  }


  getStrategy(formatHint?: string): IBibliographyFormatStrategy | undefined {
    if (!formatHint) return undefined;
    const upper = formatHint.trim().toUpperCase();
    return this.strategyByFormat.get(upper);
  }

  detectRecordFormat(
    content: string,
    hintFormat?: string,
  ): RecordFormat | null {
    const trimmed = (content || '').trim();
    const upperHint = (hintFormat || '').trim().toUpperCase();

    if (
      upperHint === 'ENDNOTE_XML' ||
      upperHint === 'MODS' ||
      upperHint === 'ZOTERO_RDF' ||
      upperHint === 'RDF' ||
      upperHint === 'MEDLINE' ||
      upperHint === 'NBIB' ||
      upperHint === 'CSV'
    ) {
      const legacyDetected = this.xmlLegacyParser.detectFormat(
        trimmed,
        upperHint,
      );
      if (legacyDetected) return legacyDetected;
    }

    const explicitStrategy = this.getStrategy(upperHint);
    if (explicitStrategy) {
      return explicitStrategy.format;
    }

    if (!trimmed) return null;

    for (const strategy of this.strategies) {
      if (strategy.matchesContent(trimmed)) {
        return strategy.format;
      }
    }

    return null;
  }

  async parseEnvelopes(
    content: string,
    formatHint?: string,
  ): Promise<ParsedBibliographyRecordEnvelope[]> {
    const resolvedFormat = this.detectRecordFormat(content, formatHint);
    if (resolvedFormat) {
      const strategy = this.getStrategy(resolvedFormat);
      if (strategy) {
        const records = await strategy.parseRecords(content);
        if (records.length > 0) {
          const sourceName =
            strategy.format === 'REFER' && formatHint
              ? formatHint
              : strategy.sourceName;

          return records.map((rawMetadata) => ({
            sourceName,
            sourceRecordId: strategy.extractRecordId
              ? strategy.extractRecordId(rawMetadata)
              : undefined,
            rawMetadata,
            confidenceScore: strategy.confidenceScore,
          }));
        }
      }
    }

    const fallbackIdRecords = parsePlainTextIdentifierList(content);
    return fallbackIdRecords.map((rawMetadata) => ({
      sourceName: 'DirectIdentifier',
      sourceRecordId:
        typeof rawMetadata.citationKey === 'string'
          ? rawMetadata.citationKey
          : undefined,
      rawMetadata,
      confidenceScore: 1.0,
    }));
  }
}
