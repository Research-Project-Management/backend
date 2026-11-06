import { Injectable, Logger } from '@nestjs/common';
import {
  cleanAbstractText,
  extractYearFromDate,
  mapCslTypeToZoteroItemType,
  normalizeArxivId,
  normalizeDoi,
  normalizeIsbn,
  normalizeIssn,
  normalizePmcid,
  normalizePmid,
  parseCreatorString,
} from '@/modules/library/core';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';

interface ParsedCslEntry {
  title: string;
  itemType: string;
  authors?: string[];
  editors?: string[];
  creators?: Array<{
    name: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    creatorType: string;
    fieldMode?: number;
  }>;
  year?: number;
  publicationDate?: string;
  accessedAt?: string;
  publicationTitle?: string;
  journal?: string;
  journalAbbr?: string;
  shortTitle?: string;
  publisher?: string;
  place?: string;
  eventPlace?: string;
  conferenceName?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  university?: string;
  thesisType?: string;
  institution?: string;
  reportNumber?: string;
  reportType?: string;
  issuingAuthority?: string;
  patentNumber?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  numPages?: string;
  numberOfVolumes?: string;
  series?: string;
  seriesNumber?: string;
  edition?: string;
  section?: string;
  versionNumber?: string;
  callNumber?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  abstract?: string;
  citationKey?: string;
  tags?: string[];
  keywords?: string[];
  notes?: string[];
  language?: string;
  rights?: string;
  extra?: string;
  extraFields?: Record<string, unknown>;
  [key: string]: unknown;
}

@Injectable()
export class CslParser {
  private readonly logger = new Logger(CslParser.name);

  /**
   * Parse a raw CSL-JSON string or object/array into a standardized list of entries.
   */
  parse(content: unknown): ParsedCslEntry[] {
    if (!content) return [];

    const toStr = (val: unknown): string => {
      if (typeof val === 'string' || typeof val === 'number') {
        return String(val).trim();
      }
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        if (typeof first === 'string' || typeof first === 'number') {
          return String(first).trim();
        }
      }
      return '';
    };
    const toOptStr = (val: unknown): string | undefined => {
      const s = toStr(val);
      return s || undefined;
    };

    let items: unknown[] = [];
    try {
      const parsed: unknown =
        typeof content === 'string' ? JSON.parse(content) : content;
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Failed to parse CSL JSON content: ${msg}`);
      return [];
    }

    const results: ParsedCslEntry[] = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const csl = item as Record<string, unknown>;

      const itemType = mapCslTypeToZoteroItemType(csl.type as string);

      const authors = this.extractPeople(csl.author);
      const editors = this.extractPeople(csl.editor);

      const creators = [
        ...this.buildCreators(csl.author, 'author'),
        ...this.buildCreators(csl.editor, 'editor'),
        ...this.buildCreators(csl.translator, 'translator'),
        ...this.buildCreators(csl['collection-editor'], 'seriesEditor'),
        ...this.buildCreators(csl['container-author'], 'bookAuthor'),
        ...this.buildCreators(csl.director, 'director'),
        ...this.buildCreators(csl.composer, 'composer'),
        ...this.buildCreators(csl.interviewer, 'interviewer'),
        ...this.buildCreators(csl.recipient, 'recipient'),
        ...this.buildCreators(csl['reviewed-author'], 'reviewedAuthor'),
        ...this.buildCreators(csl.contributor, 'contributor'),
      ];

      const issued = csl.issued as
        | {
            'date-parts'?: (number | string)[][];
            raw?: string;
            literal?: string;
          }
        | undefined;
      const year =
        issued?.['date-parts']?.[0]?.[0] != null
          ? Number(issued['date-parts'][0][0])
          : undefined;
      const publicationDate = this.formatDateParts(issued);

      const accessed = csl.accessed as
        | {
            'date-parts'?: (number | string)[][];
            raw?: string;
            literal?: string;
          }
        | undefined;
      const accessedAt = this.formatDateParts(accessed);

      const keywords = this.extractKeywords(
        csl._keywords || csl.keyword || csl.keywords || csl.subject,
      );

      const numPages = toOptStr(csl['number-of-pages']);
      const numberOfVolumes = toOptStr(csl['number-of-volumes']);
      const seriesNumber = toOptStr(csl['collection-number']);
      const chapterNumber = toOptStr(csl['chapter-number']);

      const containerTitle = toOptStr(csl['container-title']);
      const publisher = toOptStr(csl.publisher);
      const place = toOptStr(csl['publisher-place']);
      const eventPlace = toOptStr(csl['event-place']);
      const eventTitle = toOptStr(csl['event-title'] ?? csl.event);
      const genre = toOptStr(csl.genre);
      const numberVal = toOptStr(csl.number);
      const authority = toOptStr(csl.authority);

      const shortTitle = toOptStr(csl['title-short'] ?? csl.shortTitle);
      const journalAbbr = toOptStr(
        csl['container-title-short'] ?? csl.journalAbbreviation,
      );
      const section = toOptStr(csl.section);
      const versionNumber = toOptStr(csl.version);
      const callNumber = toOptStr(csl['call-number']);
      const archive = toOptStr(csl.archive);
      const archiveLocation = toOptStr(csl['archive_location']);
      const libraryCatalog = toOptStr(csl.source);
      const note = toOptStr(csl.note);
      const annote = toOptStr(csl.annote);
      const parsedNotes: string[] = [];
      if (annote) parsedNotes.push(annote);
      if (Array.isArray(csl.notes)) {
        for (const n of csl.notes) {
          const text =
            typeof n === 'string'
              ? n.trim()
              : n && typeof n === 'object'
                ? toStr(
                    (n as { content?: unknown; note?: unknown }).content ??
                      (n as { note?: unknown }).note,
                  )
                : '';
          if (text && !parsedNotes.includes(text)) {
            parsedNotes.push(text);
          }
        }
      }

      let pmid = toOptStr(csl.PMID ?? csl.pmid);
      let pmcid = toOptStr(csl.PMCID ?? csl.pmcid);
      let arxivId = toOptStr(csl.arxivId ?? csl.arXiv ?? csl.eprint);

      let cleanedExtraNote = note;
      if (note) {
        if (!pmid) {
          const m = note.match(/\bPMID\s*:\s*(\d{1,10})\b/i);
          if (m) pmid = m[1];
        }
        if (!pmcid) {
          const m =
            note.match(/\bPMCID\s*:\s*(PMC\d+)\b/i) ||
            note.match(/\b(PMC\d{1,12})\b/i);
          if (m) pmcid = m[1].toUpperCase();
        }
        if (!arxivId) {
          const m = note.match(/\barXiv\s*:\s*([^\s,;]+)/i);
          if (m) arxivId = m[1];
        }
        // Strip standalone identifier lines that were promoted to canonical fields
        const remainingLines = note
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(
            (l) =>
              Boolean(l) &&
              !/^(?:PMID\s*:\s*\d{1,10}|PMCID\s*:\s*PMC\d+|arXiv\s*:\s*[^\s,;]+(?:\s*\[[^\]]+\])?)$/i.test(
                l,
              ),
          );
        cleanedExtraNote =
          remainingLines.length > 0 ? remainingLines.join('\n') : undefined;
      }

      const university = itemType === 'thesis' ? publisher : undefined;
      const thesisType = itemType === 'thesis' ? genre : undefined;
      const institution = itemType === 'report' ? publisher : undefined;
      const reportNumber = itemType === 'report' ? numberVal : undefined;
      const reportType = itemType === 'report' ? genre : undefined;
      const issuingAuthority =
        itemType === 'patent' ? authority || publisher : authority;
      const patentNumber = itemType === 'patent' ? numberVal : undefined;
      const proceedingsTitle =
        itemType === 'conferencePaper' ? containerTitle : undefined;
      const conferenceName = eventTitle;
      const bookTitle = itemType === 'bookSection' ? containerTitle : undefined;

      const extraFields: Record<string, unknown> = {
        ...(numPages
          ? {
              numberOfPages: Number(numPages) || numPages,
              numPages: Number(numPages) || numPages,
            }
          : {}),
        ...(numberOfVolumes ? { numberOfVolumes } : {}),
        ...(seriesNumber ? { seriesNumber } : {}),
        ...(chapterNumber ? { chapterNumber, chapter: chapterNumber } : {}),
        ...(shortTitle ? { shortTitle } : {}),
        ...(journalAbbr
          ? { journalAbbr, journalAbbreviation: journalAbbr }
          : {}),
        ...(section ? { section } : {}),
        ...(versionNumber ? { versionNumber } : {}),
        ...(callNumber ? { callNumber } : {}),
        ...(archive ? { archive } : {}),
        ...(archiveLocation ? { archiveLocation } : {}),
        ...(libraryCatalog ? { libraryCatalog } : {}),
        ...(eventPlace ? { eventPlace } : {}),
        ...(conferenceName ? { conferenceName } : {}),
        ...(proceedingsTitle ? { proceedingsTitle } : {}),
        ...(bookTitle ? { bookTitle } : {}),
        ...(university ? { university } : {}),
        ...(thesisType ? { thesisType } : {}),
        ...(institution ? { institution } : {}),
        ...(reportNumber ? { reportNumber } : {}),
        ...(reportType ? { reportType } : {}),
        ...(issuingAuthority
          ? { issuingAuthority, authority: issuingAuthority }
          : {}),
        ...(patentNumber ? { patentNumber } : {}),
        ...(genre ? { genre } : {}),
        ...(numberVal ? { number: numberVal } : {}),
        ...(accessedAt ? { accessedAt, accessDate: accessedAt } : {}),
        ...(publicationDate ? { publicationDate, date: publicationDate } : {}),
        ...(pmid ? { pmid } : {}),
        ...(pmcid ? { pmcid } : {}),
        ...(arxivId ? { arxivId } : {}),
      };

      results.push({
        title: toOptStr(csl.title) || 'Untitled Document',
        itemType,
        authors: authors.length > 0 ? authors : undefined,
        editors: editors.length > 0 ? editors : undefined,
        creators: creators.length > 0 ? creators : undefined,
        year,
        publicationDate,
        accessedAt,
        publicationTitle: containerTitle,
        journal: containerTitle,
        journalAbbr,
        shortTitle,
        publisher,
        place: place || eventPlace,
        eventPlace,
        conferenceName,
        proceedingsTitle,
        bookTitle,
        university,
        thesisType,
        institution,
        reportNumber,
        reportType,
        issuingAuthority,
        patentNumber,
        volume: toOptStr(csl.volume),
        issue: toOptStr(csl.issue),
        pages: toOptStr(csl.page),
        numPages,
        numberOfVolumes,
        series: toOptStr(csl['collection-title']),
        seriesNumber,
        edition: toOptStr(csl.edition),
        section,
        versionNumber,
        callNumber,
        archive,
        archiveLocation,
        libraryCatalog,
        doi: toOptStr(csl.DOI ?? csl.doi),
        pmid,
        pmcid,
        arxivId,
        isbn: toOptStr(csl.ISBN ?? csl.isbn),
        issn: toOptStr(csl.ISSN ?? csl.issn),
        url: toOptStr(csl.URL ?? csl.url),
        abstract: toOptStr(csl.abstract),
        citationKey: toOptStr(csl.id ?? csl['citation-key']),
        tags: keywords,
        keywords,
        notes: parsedNotes.length > 0 ? parsedNotes : undefined,
        language: toOptStr(csl.language),
        rights: toOptStr(csl.rights),
        extra: cleanedExtraNote,
        extraFields:
          Object.keys(extraFields).length > 0 ? extraFields : undefined,
      });
    }

    return results;
  }

  private formatDateParts(
    dateObj:
      | { 'date-parts'?: (number | string)[][]; raw?: string; literal?: string }
      | undefined,
  ): string | undefined {
    if (!dateObj || typeof dateObj !== 'object') return undefined;
    const parts = dateObj['date-parts']?.[0];
    if (Array.isArray(parts) && parts.length > 0 && parts[0] != null) {
      const y = String(parts[0]).trim();
      if (!y) return undefined;
      if (parts.length === 1 || parts[1] == null) return y;
      const m = String(parts[1]).trim().padStart(2, '0');
      if (parts.length === 2 || parts[2] == null) return `${y}-${m}`;
      const d = String(parts[2]).trim().padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const fallback = dateObj.raw || dateObj.literal;
    return typeof fallback === 'string' && fallback.trim()
      ? fallback.trim()
      : undefined;
  }

  private extractPeople(people: unknown): string[] {
    if (!Array.isArray(people)) return [];
    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    return people
      .map((p: unknown) => {
        if (!p || typeof p !== 'object') return '';
        const rec = p as Record<string, unknown>;
        const literal = toStr(rec.literal);
        if (literal) return literal;
        const given = toStr(rec.given);
        const family = toStr(rec.family);
        if (given && family) return `${given} ${family}`.trim();
        return family || given || '';
      })
      .filter(Boolean);
  }

  private buildCreators(
    people: unknown,
    creatorType: string,
  ): Array<{
    name: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    creatorType: string;
    fieldMode?: number;
  }> {
    if (!Array.isArray(people)) return [];
    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    return people
      .map((p: unknown) => {
        if (!p || typeof p !== 'object') return null;
        const rec = p as Record<string, unknown>;
        const literal = toStr(rec.literal);
        const rawGiven = toStr(rec.given);
        const rawFamily = toStr(rec.family);
        if (literal && !rawGiven && !rawFamily) {
          return {
            name: literal,
            fullName: literal,
            firstName: '',
            lastName: literal,
            creatorType,
            fieldMode: 1,
          };
        }
        const nonDropping = toStr(rec['non-dropping-particle']);
        const dropping = toStr(rec['dropping-particle']);
        const prefix = nonDropping
          ? `${nonDropping} `
          : dropping
            ? `${dropping} `
            : '';
        const suffixStr = toStr(rec.suffix);
        const suffix = suffixStr ? ` ${suffixStr}` : '';
        const family = rawFamily ? `${prefix}${rawFamily}${suffix}`.trim() : '';
        const given = rawGiven;
        const name =
          literal ||
          (given && family ? `${given} ${family}` : family || given || '');
        if (!name) return null;
        const cleanName = name.trim();
        return {
          name: cleanName,
          fullName: cleanName,
          firstName: given || undefined,
          lastName: family || undefined,
          creatorType,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }

  private extractKeywords(raw: unknown): string[] | undefined {
    if (Array.isArray(raw)) {
      const list = normalizeTags(
        raw.map((k) => {
          if (typeof k === 'string') return k;
          if (typeof k === 'object' && k !== null) {
            const obj = k as Record<string, unknown>;
            const val = obj.name ?? obj.keyword ?? obj.value ?? obj.tag ?? '';
            return typeof val === 'string' || typeof val === 'number'
              ? String(val)
              : '';
          }
          return k != null ? String(k) : '';
        }),
      );
      return list.length > 0 ? list : undefined;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const list = normalizeTags([raw]);
      return list.length > 0 ? list : undefined;
    }
    return undefined;
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
