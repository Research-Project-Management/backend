import { Injectable, Optional } from '@nestjs/common';
import { RecordFormat } from '@/modules/library/ingestion/types/ingestion.types';
import { BibtexParser } from './bibtex.parser';
import { RisParser } from './ris.parser';
import { CslParser } from './csl.parser';
import { XmlLegacyFormatsParser } from './xml-legacy-formats.parser';
import { mapBibtexToRawRecord } from '@/modules/library/ingestion/domain/metadata.validator';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import { cleanAbstractText, extractYearFromDate, normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid, normalizeIsbn, normalizeIssn, parseCreatorString } from '@/modules/library/core';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';

export interface ParsedBibliographyRecordEnvelope {
  sourceName: string;
  sourceRecordId?: string;
  rawMetadata: Record<string, unknown>;
  confidenceScore: number;
}

export interface IBibliographyFormatStrategy {
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
    if (!resolvedFormat) return [];

    const strategy = this.getStrategy(resolvedFormat);
    if (!strategy) return [];

    const records = await strategy.parseRecords(content);
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

/**
 * PubMed / MEDLINE Tagged Format (.nbib / .txt)
 */
export function parseMedlineNbibRecords(content: string): ItemMetadata[] {
  const records = content
    .split(/\r?\n\s*\r?\n+/)
    .filter((chunk) => /^(?:PMID|TI|AU|FAU)\s*-/m.test(chunk));
  const chunks = records.length > 0 ? records : [content];
  const items: ItemMetadata[] = [];

  for (const chunk of chunks) {
    const fields = new Map<string, string[]>();
    let currentKey = '';
    for (const rawLine of chunk.split(/\r?\n/)) {
      const tagMatch = rawLine.match(/^([A-Z]{2,4})\s*-\s*(.*)$/);
      if (tagMatch) {
        currentKey = tagMatch[1].trim();
        const list = fields.get(currentKey) || [];
        list.push(tagMatch[2].trim());
        fields.set(currentKey, list);
      } else if (currentKey && /^\s{2,}\S/.test(rawLine)) {
        const list = fields.get(currentKey);
        if (list && list.length > 0) {
          list[list.length - 1] = `${list[list.length - 1]} ${rawLine.trim()}`;
        }
      }
    }

    const title = fields.get('TI')?.[0] || fields.get('BTI')?.[0];
    if (!title) continue;

    const rawAuthors = fields.get('FAU') || fields.get('AU') || [];
    const creators = rawAuthors.map((a, idx) =>
      parseCreatorString(a, idx, 'author'),
    );
    const pmid = normalizePmid(fields.get('PMID')?.[0] || '') || undefined;
    const pmcid = normalizePmcid(fields.get('PMC')?.[0] || '') || undefined;
    const dp = fields.get('DP')?.[0];
    const year = extractYearFromDate(dp);
    const journal = fields.get('JT')?.[0] || fields.get('TA')?.[0];
    const journalAbbr = fields.get('TA')?.[0];
    const volume = fields.get('VI')?.[0];
    const issue = fields.get('IP')?.[0];
    const pages = fields.get('PG')?.[0];
    const abstract = cleanAbstractText(fields.get('AB')?.join(' '));
    const issn = normalizeIssn(fields.get('IS')?.[0] || '') || undefined;

    let doi: string | undefined;
    const ids = [...(fields.get('LID') || []), ...(fields.get('AID') || [])];
    for (const idLine of ids) {
      if (/\[doi\]/i.test(idLine) || /^10\.\d{4,9}\//.test(idLine)) {
        const cleaned = idLine.replace(/\s*\[doi\]/i, '').trim();
        doi = normalizeDoi(cleaned) || cleaned;
        break;
      }
    }

    const keywords = normalizeTags([
      ...(fields.get('OT') || []),
      ...(fields.get('MH') || []).map((m) => m.replace(/\*/g, '')),
    ]);

    items.push({
      title,
      itemType: 'journalArticle',
      authors: rawAuthors,
      creators,
      year,
      publicationDate: dp,
      publicationTitle: journal,
      journal,
      journalAbbr,
      volume,
      issue,
      pages,
      doi,
      pmid,
      pmcid,
      issn,
      abstract: abstract || undefined,
      keywords,
      tags: keywords,
    });
  }

  return items;
}

/**
 * Standardized Bibliographic CSV (Zotero CSV / Generic CSV)
 */
export function parseCsvBibliographyRecords(content: string): ItemMetadata[] {
  const rows = parseCsvRows(content);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) =>
    h
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase(),
  );
  const items: ItemMetadata[] = [];

  const getCol = (row: string[], names: string[]): string | undefined => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx !== -1 && row[idx]?.trim()) {
        return row[idx].trim();
      }
    }
    return undefined;
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => !cell.trim())) continue;

    const title = getCol(row, ['title', 'item title', 'article title']);
    const doiRaw = getCol(row, ['doi']);
    if (!title && !doiRaw) continue;

    const itemType =
      getCol(row, ['item type', 'itemtype', 'type']) || 'journalArticle';
    const authorRaw = getCol(row, ['author', 'authors', 'creators']) || '';
    const authorList = authorRaw
      .split(/\s*;\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    const creators = authorList.map((a, idx) =>
      parseCreatorString(a, idx, 'author'),
    );

    const yearStr = getCol(row, ['publication year', 'year']);
    const dateStr = getCol(row, ['date', 'publication date']) || yearStr;
    const year = extractYearFromDate(yearStr || dateStr);
    const pubTitle = getCol(row, [
      'publication title',
      'journal',
      'book title',
      'proceedings title',
    ]);
    const publisher = getCol(row, ['publisher']);
    const volume = getCol(row, ['volume']);
    const issue = getCol(row, ['issue', 'number']);
    const pages = getCol(row, ['pages']);
    const url = getCol(row, ['url', 'link']);
    const abstract = cleanAbstractText(
      getCol(row, ['abstract note', 'abstract']),
    );
    const citationKey = getCol(row, ['citation key', 'citationkey', 'key']);
    const isbn = normalizeIsbn(getCol(row, ['isbn']) || '') || undefined;
    const issn = normalizeIssn(getCol(row, ['issn']) || '') || undefined;
    const doi = doiRaw ? normalizeDoi(doiRaw) || doiRaw : undefined;
    const pmid = normalizePmid(getCol(row, ['pmid']) || '') || undefined;
    const arxivId =
      normalizeArxivId(getCol(row, ['arxiv', 'arxivid']) || '') || undefined;

    const rawTags = [
      getCol(row, ['manual tags', 'tags', 'keywords']),
      getCol(row, ['automatic tags']),
    ]
      .filter(Boolean)
      .join(';')
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const tags = normalizeTags(rawTags);

    items.push({
      title: title || doi || 'Untitled Record',
      itemType,
      authors: authorList,
      creators,
      year,
      publicationDate: dateStr,
      publicationTitle: pubTitle,
      journal: itemType === 'journalArticle' ? pubTitle : undefined,
      publisher,
      volume,
      issue,
      pages,
      doi,
      isbn,
      issn,
      pmid,
      arxivId,
      url,
      citationKey,
      abstract: abstract || undefined,
      keywords: tags,
      tags,
    });
  }

  return items;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentField);
      currentField = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  return rows;
}
